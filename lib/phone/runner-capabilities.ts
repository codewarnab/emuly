/** A runner gains capabilities on update and never loses them, so a good answer can be kept for a while. */
export const CAPABILITIES_TTL_MS = 5 * 60 * 1000;

/** The Apps route needs these. A runner without one of them is asked again on each call. */
const REQUIRED = ["apkUpload", "fileFetch"];

type Health = (userId: number, id: string) => Promise<Response>;

/**
 * Remembers the runner capabilities of each phone, so each Apps call (and each 4 MiB upload chunk)
 * does not ask the runner for /health first. Only a good answer with every REQUIRED capability is kept: a failed
 * /health or an old runner is asked again on the next call, so a runner update works at once.
 */
export function createRunnerCapabilities(health: Health, now: () => number = Date.now) {
  const cache = new Map<string, { capabilities: string[]; until: number }>();
  return {
    async get(userId: number, id: string): Promise<string[]> {
      const key = `${userId}:${id}`;
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.capabilities;
      cache.delete(key);
      const response = await health(userId, id);
      if (!response.ok) return [];
      const status = await response.json().catch(() => null) as { capabilities?: unknown } | null;
      const capabilities = Array.isArray(status?.capabilities) ? status.capabilities.filter((item): item is string => typeof item === "string") : [];
      if (REQUIRED.every(name => capabilities.includes(name))) {
        if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
        cache.set(key, { capabilities, until: now() + CAPABILITIES_TTL_MS });
      }
      return capabilities;
    },
    forget(userId: number, id: string) { cache.delete(`${userId}:${id}`); },
  };
}
