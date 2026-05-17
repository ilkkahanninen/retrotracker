import type { Context } from "hono";

/**
 * Structured single-line audit events. Emitted to stdout under a fixed
 * `[audit]` prefix so operators can grep them out or pipe to journald
 * without parsing all of stderr/stdout. Intentionally not a heavy
 * logger framework — the surface is small enough that one helper
 * covers all sites.
 *
 * What we log: who (hashed sub) + what (event kind) + where (client
 * IP) + when (ISO timestamp). Never the raw OIDC `sub` (operators
 * already see the hash via disk paths), never the cookie / token,
 * never the file contents.
 */
export type AuditEvent =
  | { evt: "auth.login.start"; ip: string }
  | {
      evt: "auth.login.success";
      ip: string;
      userHash: string;
      name?: string;
    }
  | { evt: "auth.login.failure"; ip: string; reason: string }
  | { evt: "auth.logout"; ip: string; userHash: string | null }
  | {
      evt: "file.delete";
      ip: string;
      userHash: string | null;
      resource: string;
      name: string;
    }
  // Share lifecycle. `tokenPrefix` is the first 6 chars of the share
  // token — never the full token, since anyone who can read the audit
  // log could otherwise hijack live shares. `ownerHash` is hashed.
  | {
      evt: "share.create";
      ip: string;
      userHash: string;
      resource: string;
      name: string;
      tokenPrefix: string;
    }
  | {
      evt: "share.delete";
      ip: string;
      userHash: string;
      tokenPrefix: string;
    }
  | {
      evt: "share.read";
      ip: string;
      tokenPrefix: string;
      ownerHash: string;
      resource: string;
      name: string;
    };

export function audit(e: AuditEvent): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...e });
  // eslint-disable-next-line no-console
  console.log(`[audit] ${line}`);
}

/**
 * Best-effort client IP. The Node shim populates `x-real-ip` from the
 * socket; if a reverse proxy is in play and the operator opts in (via
 * future config), `x-forwarded-for`'s first hop wins. Falls back to
 * "unknown" if neither is set (e.g. unit tests).
 */
export function clientIp(c: Context): string {
  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp;
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return "unknown";
}
