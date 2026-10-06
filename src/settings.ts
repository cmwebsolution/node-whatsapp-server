export function integer(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}`);
  return value;
}
export function runtimeSettings() {
  return {
    // A pilot ceiling; production approval is recorded separately by the release gate.
    maxSessions: integer("MAX_SESSIONS", 1, 1, 500),
    connectionConcurrency: integer("CONNECTION_CONCURRENCY", 5, 1, 25),
    mediaRequests: integer("MEDIA_REQUEST_CONCURRENCY", 4, 1, 10),
    mediaSends: integer("MEDIA_SEND_CONCURRENCY", 2, 1, 10),
    restoreStaggerMs: integer("RESTORE_STAGGER_MS", 100, 10, 5000),
    shutdownMs: integer("SHUTDOWN_TIMEOUT_MS", 30000, 5000, 60000),
  };
}
