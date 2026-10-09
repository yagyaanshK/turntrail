// Runs a usage scan off the extension host's main thread. The first scan of a
// long history reads gigabytes of transcripts; done in the host it made every
// other Turntrail view slow to respond for the minute it took. The index it
// writes is read back by the host when this finishes.
const { parentPort, workerData } = require('node:worker_threads');

(async () => {
  // Loaded outside a worker (a syntax or scope check), it does nothing.
  if (!parentPort) return;
  try {
    const { scanUsage } = await import('@turntrail/core');
    const index = await scanUsage(workerData || {});
    parentPort.postMessage({ ok: true, files: Object.keys(index.files || {}).length, scan: index.lastScan });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
})();
