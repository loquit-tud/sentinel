/**
 * KV Cache Helpers — consolidated caching pattern.
 *
 * Encapsulates: check KV → compute → store pattern with TTL.
 */

/**
 * Minimal KV interface for type safety across packages.
 * (Real implementations use Cloudflare KVNamespace or similar.)
 */
export interface KVLike {
  get(key: string, type?: string): Promise<any>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

/**
 * Generic KV caching wrapper with automatic computation & storage.
 *
 * @param kv - KV-like storage (may be undefined)
 * @param key - Cache key
 * @param ttl - Time-to-live in seconds
 * @param computeFn - Async computation function
 * @returns Cached result if hit, otherwise computed & stored result
 */
export async function cachedCompute<T>(
  kv: KVLike | undefined,
  key: string,
  ttl: number,
  computeFn: () => Promise<T>,
): Promise<T> {
  // Try KV cache first
  if (kv) {
    const cached = await kv.get(key, 'json') as T | null;
    if (cached != null) {
      return cached;
    }
  }

  // Compute
  const result = await computeFn();

  // Store in KV
  if (kv) {
    kv.put(key, JSON.stringify(result), { expirationTtl: ttl }).catch(() => {});
  }

  return result;
}
