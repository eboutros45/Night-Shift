// File storage behind three functions so local disk can later become S3/R2 without
// touching callers. Files are typed by their magic bytes, never by the client's claim.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { DomainError } from "../domain/status.ts";

export type Bucket = "proofs" | "media";

const KINDS = [
  { ext: "png", mime: "image/png", sig: [0x89, 0x50, 0x4e, 0x47] },
  { ext: "jpg", mime: "image/jpeg", sig: [0xff, 0xd8, 0xff] },
  { ext: "webp", mime: "image/webp", sig: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP checked below
  { ext: "pdf", mime: "application/pdf", sig: [0x25, 0x50, 0x44, 0x46] },
] as const;

function sniff(buf: Buffer) {
  return KINDS.find(
    (k) => k.sig.every((b, i) => buf[i] === b) && (k.ext !== "webp" || buf.subarray(8, 12).toString() === "WEBP"),
  );
}

const ALLOWED: Record<Bucket, readonly string[]> = { proofs: ["png", "jpg", "webp", "pdf"], media: ["png", "jpg", "webp"] };
const keyPattern = /^[a-f0-9]{32}\.(png|jpg|webp|pdf)$/;

function storageUrl(bucket: Bucket, key: string) {
  const base = new URL(config.supabase.url);
  if (base.protocol !== "https:") throw new Error("SUPABASE_URL must use HTTPS");
  return new URL(`/storage/v1/object/${bucket}/${key}`, base);
}
function storageHeaders() {
  if (!config.supabase.secretKey) throw new Error("SUPABASE_SECRET_KEY is required");
  const headers: Record<string, string> = { apikey: config.supabase.secretKey };
  if (!config.supabase.secretKey.startsWith("sb_secret_")) headers.Authorization = `Bearer ${config.supabase.secretKey}`;
  return headers;
}

export async function saveUpload(bucket: Bucket, file: File) {
  if (file.size === 0) throw new DomainError("EMPTY_FILE", "The file is empty.");
  if (file.size > config.uploadLimitBytes) throw new DomainError("FILE_TOO_BIG", "Files must be 5 MB or smaller.", 413);
  const buf = Buffer.from(await file.arrayBuffer());
  const kind = sniff(buf);
  if (!kind || !ALLOWED[bucket].includes(kind.ext))
    throw new DomainError("BAD_FILE", `Upload a ${ALLOWED[bucket].join(", ").toUpperCase()} file.`);
  const key = `${randomBytes(16).toString("hex")}.${kind.ext}`;
  if (config.supabase.url) {
    const response = await fetch(storageUrl(bucket, key), {
      method: "POST", headers: { ...storageHeaders(), "Content-Type": kind.mime, "x-upsert": "false" }, body: new Uint8Array(buf),
    });
    if (!response.ok) throw new Error(`Storage upload failed (${response.status})`);
  } else {
    await mkdir(join(config.storageDir, bucket), { recursive: true });
    await writeFile(join(config.storageDir, bucket, key), buf);
  }
  return { key, mime: kind.mime };
}

export async function readStored(bucket: Bucket, key: string) {
  if (!keyPattern.test(key)) return null;
  if (config.supabase.url) {
    const response = await fetch(storageUrl(bucket, key), { headers: storageHeaders() });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Storage download failed (${response.status})`);
    return { buf: Buffer.from(await response.arrayBuffer()), mime: KINDS.find((k) => key.endsWith(`.${k.ext}`))!.mime };
  }
  try {
    const buf = await readFile(join(config.storageDir, bucket, key));
    return { buf, mime: KINDS.find((k) => key.endsWith(`.${k.ext}`))!.mime };
  } catch {
    return null;
  }
}

export async function removeStored(bucket: Bucket, key: string) {
  if (config.supabase.url && keyPattern.test(key)) {
    const response = await fetch(new URL(`/storage/v1/object/${bucket}`, config.supabase.url), {
      method: "DELETE", headers: { ...storageHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [key] }),
    });
    if (!response.ok && response.status !== 404) throw new Error(`Storage delete failed (${response.status})`);
    return;
  }
  if (keyPattern.test(key)) await rm(join(config.storageDir, bucket, key), { force: true });
}
