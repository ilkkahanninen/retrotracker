import { createHash, randomBytes } from "node:crypto";
import * as jose from "jose";

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  jwks_uri: string;
}

export interface OidcUser {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
}

export interface OidcDeps {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Cached OIDC discovery + JWKS. The issuer's metadata rarely changes,
 * and `jose.createRemoteJWKSet` caches keys internally with refresh on
 * `kid` miss — we just keep one set per issuer.
 */
export class OidcClient {
  private metadataPromise: Promise<OidcMetadata> | null = null;
  private jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

  constructor(private readonly deps: OidcDeps) {}

  async metadata(): Promise<OidcMetadata> {
    if (!this.metadataPromise) {
      this.metadataPromise = this.fetchMetadata();
    }
    return this.metadataPromise;
  }

  private async fetchMetadata(): Promise<OidcMetadata> {
    const url = `${this.deps.issuer}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) {
      this.metadataPromise = null;
      throw new Error(`OIDC discovery failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as OidcMetadata;
  }

  private async jwksSet(): Promise<ReturnType<typeof jose.createRemoteJWKSet>> {
    if (this.jwks) return this.jwks;
    const meta = await this.metadata();
    this.jwks = jose.createRemoteJWKSet(new URL(meta.jwks_uri));
    return this.jwks;
  }

  /**
   * Build the authorization-endpoint URL for a fresh login flow.
   * Caller is responsible for persisting `state` + `nonce` +
   * `codeVerifier` so the callback can verify them.
   */
  async buildAuthorizationUrl(opts: {
    state: string;
    nonce: string;
    codeChallenge: string;
    scope?: string;
  }): Promise<string> {
    const meta = await this.metadata();
    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.deps.clientId);
    url.searchParams.set("redirect_uri", this.deps.redirectUri);
    url.searchParams.set("scope", opts.scope ?? "openid profile email");
    url.searchParams.set("state", opts.state);
    url.searchParams.set("nonce", opts.nonce);
    url.searchParams.set("code_challenge", opts.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  /**
   * Exchange the `code` for tokens, verify the ID token, return the
   * extracted user. Throws on any mismatch (signature, iss, aud, exp,
   * nonce).
   */
  async exchangeCode(opts: {
    code: string;
    codeVerifier: string;
    expectedNonce: string;
  }): Promise<OidcUser> {
    const meta = await this.metadata();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: this.deps.redirectUri,
      client_id: this.deps.clientId,
      client_secret: this.deps.clientSecret,
      code_verifier: opts.codeVerifier,
    });
    const res = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`token exchange failed: ${res.status} ${text}`);
    }
    const tokens = (await res.json()) as {
      id_token?: string;
      access_token?: string;
    };
    if (!tokens.id_token) {
      throw new Error("token response missing id_token");
    }
    const jwks = await this.jwksSet();
    const { payload } = await jose.jwtVerify(tokens.id_token, jwks, {
      issuer: meta.issuer,
      audience: this.deps.clientId,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("id_token missing sub claim");
    }
    if (payload["nonce"] !== opts.expectedNonce) {
      throw new Error("id_token nonce mismatch");
    }
    return {
      sub: payload.sub,
      name: stringOrUndef(payload["name"]),
      email: stringOrUndef(payload["email"]),
      picture: stringOrUndef(payload["picture"]),
    };
  }

  /** RP-initiated end-session URL when the provider advertises one. */
  async endSessionUrl(postLogoutRedirect: string): Promise<string | null> {
    const meta = await this.metadata();
    if (!meta.end_session_endpoint) return null;
    const url = new URL(meta.end_session_endpoint);
    url.searchParams.set("client_id", this.deps.clientId);
    url.searchParams.set("post_logout_redirect_uri", postLogoutRedirect);
    return url.toString();
  }
}

/** Random URL-safe token of `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** PKCE pair: verifier + S256 challenge. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  const challenge = createHash("sha256")
    .update(verifier)
    .digest()
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
