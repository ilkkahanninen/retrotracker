import * as jose from "jose";
import type { OidcUser } from "./oidc.js";

/**
 * Shape stored in the signed session cookie. Kept small — just enough
 * for the UI to render "Signed in as Name" and for the storage layer
 * to scope by `sub`. Fresh user-info on every request would mean an
 * extra round-trip to the IdP, which we don't need yet.
 */
export interface SessionPayload {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
}

const ALG = "HS256";
const COOKIE_LIFETIME = "7d";

/**
 * `iss` and `aud` are checked on every verify so the same HMAC secret
 * can't be re-used by another service to mint tokens accepted here
 * (and vice versa). Values are app-private constants — they never
 * touch a wire.
 */
const SESSION_ISSUER = "retrotracker";
const SESSION_AUDIENCE = "retrotracker-spa";

export async function signSession(
  secret: Uint8Array,
  user: OidcUser,
): Promise<string> {
  return await new jose.SignJWT({
    name: user.name,
    email: user.email,
    picture: user.picture,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(user.sub)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(COOKIE_LIFETIME)
    .sign(secret);
}

export async function verifySession(
  secret: Uint8Array,
  token: string,
): Promise<SessionPayload> {
  const { payload } = await jose.jwtVerify(token, secret, {
    algorithms: [ALG],
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
  });
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("session missing sub");
  }
  return {
    sub: payload.sub,
    name: stringOrUndef(payload["name"]),
    email: stringOrUndef(payload["email"]),
    picture: stringOrUndef(payload["picture"]),
  };
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
