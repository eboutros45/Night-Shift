import { beforeAll, expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { OWNER_EMAIL, verifyAccess } from "../src/cloud/access.ts";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { keys = await generateKeyPair("RS256"); });
const settings = { ACCESS_TEAM_DOMAIN: "nightshift-test.cloudflareaccess.com", ACCESS_AUD: "nightshift-app" };
async function token(email = OWNER_EMAIL, audience = settings.ACCESS_AUD, expires = "5m") {
  return new SignJWT({ email }).setProtectedHeader({ alg: "RS256" }).setIssuer(`https://${settings.ACCESS_TEAM_DOMAIN}`).setAudience(audience).setSubject("owner").setIssuedAt().setExpirationTime(expires).sign(keys.privateKey);
}
const request = (token?: string) => new Request("https://night-shift.elieboutros.dev/admin", { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });
it("accepts only the signed owner identity for this application", async () => {
  expect(await verifyAccess(request(await token()), settings, async () => keys.publicKey)).toBe(true);
  expect(await verifyAccess(request(await token("other@example.com")), settings, async () => keys.publicKey)).toBe(false);
});
it("denies missing configuration, absent and forged tokens", async () => {
  expect(await verifyAccess(request(), settings)).toBe(false);
  expect(await verifyAccess(request("forged"), settings, async () => keys.publicKey)).toBe(false);
  expect(await verifyAccess(request(await token()), {}, async () => keys.publicKey)).toBe(false);
});
it("rejects expired tokens and tokens for a different application", async () => {
  expect(await verifyAccess(request(await token(OWNER_EMAIL, "another-app")), settings, async () => keys.publicKey)).toBe(false);
  expect(await verifyAccess(request(await token(OWNER_EMAIL, settings.ACCESS_AUD, "-1m")), settings, async () => keys.publicKey)).toBe(false);
});
