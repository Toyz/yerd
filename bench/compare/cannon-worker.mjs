// One autocannon instance in a worker thread; run.mjs starts several so the client isn't the
// bottleneck (one autocannon thread tops out around 125k req/s). Waits for "go", runs, and posts
// back its summary plus, when asked, every 2xx response time in ms (autocannon's own histogram
// only resolves whole milliseconds).
import { parentPort, workerData } from "node:worker_threads";
import autocannon from "autocannon";

const { options, collect } = workerData;

parentPort.once("message", () => {
  let values = new Float64Array(collect ? 1 << 21 : 0);
  let length = 0;
  const tracker = autocannon(options, (error, result) => {
    if (error) {
      parentPort.postMessage({ error: String(error) });
      return;
    }
    const latencies = values.slice(0, length);
    parentPort.postMessage(
      {
        // In a worker thread autocannon hands back raw counters, not its aggregated summary.
        reqPerSec: result.totalCompletedRequests / result.duration,
        bytesPerSec: result.totalBytes / result.duration,
        errors: result.errors + result.non2xx,
        latencies,
      },
      [latencies.buffer],
    );
  });
  if (collect) {
    tracker.on("response", (_client, status, _bytes, ms) => {
      if (status < 200 || status >= 300) return;
      if (length === values.length) {
        const bigger = new Float64Array(values.length * 2);
        bigger.set(values);
        values = bigger;
      }
      values[length++] = ms;
    });
  }
});

parentPort.postMessage({ ready: true });
