import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const OWNER_EMAIL = "eliebo2006@gmail.com";
export type AccessSettings = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };
const keySets = new Map<string, JWTVerifyGetKey>();
export async function verifyAccess(request: Request, settings: AccessSettings, testKey?: JWTVerifyGetKey): Promise<boolean> {
  const domain = settings.ACCESS_TEAM_DOMAIN;
  if (!domain || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) || !settings.ACCESS_AUD) return false;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;
  const issuer = `https://${domain}`;
  try {
    let key = testKey ?? keySets.get(issuer);
    if (!key) { key = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); keySets.set(issuer, key); }
    const { payload } = await jwtVerify(token, key, { issuer, audience: settings.ACCESS_AUD, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "email"] });
    return payload.email === OWNER_EMAIL;
  } catch { return false; }
}
