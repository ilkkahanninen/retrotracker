import type { Context, Next } from "hono";
import { clientIp } from "./audit.js";

/**
 * Per-key token bucket. Cheap in-memory state — fine for a single-node
 * deploy. For multi-node we'd need shared state (Redis), but this
 * project ships as a single container so a process-local map is the
 * right scope. Each bucket has `capacity` tokens; consumed on every
 * accepted request, refilled at `refillPerSec`.
 */
interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;

function take(
  key: string,
  capacity: number,
  refillPerSec: number,
  now: number,
): boolean {
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= MAX_BUCKETS) {
      // Cheap eviction so we don't grow without bound under churn —
      // drop the oldest entry by iteration order.
      const first = buckets.keys().next().value;
      if (first !== undefined) buckets.delete(first);
    }
    b = { tokens: capacity, lastRefill: now };
    buckets.set(key, b);
  } else {
    const dt = (now - b.lastRefill) / 1000;
    b.tokens = Math.min(capacity, b.tokens + dt * refillPerSec);
    b.lastRefill = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

export interface RateLimitOpts {
  /** Burst capacity — first N requests come through immediately. */
  capacity: number;
  /** Steady-state refill rate. */
  refillPerSec: number;
  /** Sub-key for routes that share the limiter map — e.g. "login". */
  scope: string;
}

/**
 * Hono middleware enforcing a per-IP token bucket. 429s when the
 * bucket is empty; otherwise passes through. The IP comes from
 * `clientIp(c)`, which reads the shim-injected `x-real-ip`.
 */
export function rateLimit(opts: RateLimitOpts) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const ip = clientIp(c);
    const key = `${opts.scope}:${ip}`;
    if (!take(key, opts.capacity, opts.refillPerSec, Date.now())) {
      return c.json(
        { error: "rate-limited", message: "too many requests, slow down" },
        429,
      );
    }
    return next();
  };
}

/** Visible only for tests. */
export function _resetBuckets(): void {
  buckets.clear();
}
