// Container readiness probe: no credentials or diagnostic dumps in arguments/output.
try {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
  const response = await fetch(`http://127.0.0.1:${port}/ready`, {
    signal: AbortSignal.timeout(5500),
  });
  if (!response.ok) throw new Error();
} catch {
  process.exitCode = 1;
}
export {};
