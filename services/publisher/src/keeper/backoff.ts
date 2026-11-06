/**
 * Per-key exponential backoff kept in memory: after the n-th consecutive failure a key is skipped for
 * `min(baseMs * 2^(n-1), maxMs)`. A restart forgets it, which at worst costs one retry per key.
 */
export class Backoff {
  private readonly entries = new Map<string, { failures: number; until: number }>();
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;

  constructor(opts: { baseMs?: number; maxMs?: number; now?: () => number } = {}) {
    this.baseMs = opts.baseMs ?? 5 * 60_000;
    this.maxMs = opts.maxMs ?? 6 * 3_600_000;
    this.now = opts.now ?? Date.now;
  }

  /** True while `key` is waiting out a backoff. */
  blocked(key: string): boolean {
    const e = this.entries.get(key);
    return e !== undefined && this.now() < e.until;
  }

  /**
   * Records a failure and returns the delay before the next attempt, in ms. `notAfter` (epoch ms)
   * caps the wait, for failures known to clear at a given time.
   */
  fail(key: string, notAfter?: number): number {
    const failures = (this.entries.get(key)?.failures ?? 0) + 1;
    let delay = Math.min(this.baseMs * 2 ** (failures - 1), this.maxMs);
    if (notAfter !== undefined) delay = Math.max(0, Math.min(delay, notAfter - this.now()));
    this.entries.set(key, { failures, until: this.now() + delay });
    return delay;
  }

  failures(key: string): number {
    return this.entries.get(key)?.failures ?? 0;
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
