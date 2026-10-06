// Some managed hosts require() the entry file instead of executing it.
// Dynamic import keeps the asynchronous ESM dependency graph supported.
void import("./server.js").catch(() => {
  console.error(
    "STARTUP_UNAVAILABLE: application entry could not load. Verify build and Node version.",
  );
  process.exitCode = 1;
});
