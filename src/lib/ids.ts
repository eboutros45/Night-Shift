import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { config } from "../config.ts";

export const newId = () => randomUUID();
/** 128 bits, base64url (22 chars). Used for ticket QR codes and customer order links. */
export const secretToken = () => randomBytes(16).toString("base64url");

// No 0/O/1/I so references survive being read aloud or copied by hand.
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function orderReference() {
  let s = "";
  for (let i = 0; i < 6; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `${config.brand.orderPrefix}-${s}`;
}

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
