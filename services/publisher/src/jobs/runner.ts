import type { Job, Log } from "./types.js";

/**
 * Runs each job on its own interval, once shortly after start. A run never overlaps the previous
 * run of the same job; errors are logged by name only (messages may carry URLs).
 */
export function startJobs(jobs: Job[], log: Log, opts: { initialDelayMs?: number } = {}): () => void {
  const timers: ReturnType<typeof setInterval>[] = [];
  for (const job of jobs) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await job.run();
      } catch (err) {
        log("error", `job ${job.name} failed`, { error: err instanceof Error ? err.name : "unknown" });
      } finally {
        running = false;
      }
    };
    timers.push(setTimeout(tick, opts.initialDelayMs ?? 5_000));
    timers.push(setInterval(tick, job.intervalMs));
    log("info", "job scheduled", { job: job.name, intervalSeconds: Math.round(job.intervalMs / 1000) });
  }
  return () => {
    for (const t of timers) clearInterval(t);
  };
}
