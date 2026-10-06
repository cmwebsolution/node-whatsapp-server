import { monitorEventLoopDelay } from "node:perf_hooks";
export function startMetrics(snapshot: () => Promise<unknown>) {
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let cpu = process.cpuUsage(),
    window = performance.now(),
    busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    const used = process.cpuUsage(cpu),
      elapsed = performance.now() - window;
    cpu = process.cpuUsage();
    window = performance.now();
    const metrics = {
      event: "runtime_metrics",
      at: new Date().toISOString(),
      window_ms: Math.round(elapsed),
      rss_bytes: process.memoryUsage().rss,
      heap_bytes: process.memoryUsage().heapUsed,
      cpu_ms: (used.user + used.system) / 1000,
      cpu_one_core_percent:
        Math.round(((used.user + used.system) / 1000 / elapsed) * 10000) / 100,
      event_loop_p99_ms: delay.percentile(99) / 1e6,
    };
    delay.reset();
    void snapshot()
      .then((sessions) => console.log(JSON.stringify({ ...metrics, sessions })))
      .catch(() =>
        console.log(JSON.stringify({ ...metrics, database_available: false })),
      )
      .finally(() => {
        busy = false;
      });
  }, 60000);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}
