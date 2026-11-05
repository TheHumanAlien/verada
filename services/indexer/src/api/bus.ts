import { type Cursor } from "./cursor";
import { type ActivityItem, activityCursor, isNewer } from "./types";

/**
 * Shared poller behind every SSE connection. It runs only while someone is subscribed, keeps a
 * bounded set of already-announced ids, and pushes unseen items oldest-first.
 */
export class ActivityBus {
  private subs = new Set<(items: ActivityItem[]) => void>();
  private seen = new Set<string>();
  private seeded = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: ActivityItem[] = [];
  private running = false;

  constructor(
    private readonly fetchLatest: () => Promise<ActivityItem[]>,
    private readonly pollMs: number,
    private readonly maxSeen = 2_000,
  ) {}

  get size() {
    return this.subs.size;
  }

  subscribe(fn: (items: ActivityItem[]) => void): () => void {
    this.subs.add(fn);
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.pollMs);
      this.timer.unref?.();
      void this.tick();
    }
    return () => {
      this.subs.delete(fn);
      if (this.subs.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.seeded = false;
        this.seen.clear();
      }
    };
  }

  /** Newest window of the feed, refreshed from the store. */
  async window(): Promise<ActivityItem[]> {
    this.latest = await this.fetchLatest();
    return this.latest;
  }

  /** Items in the current window strictly newer than `after`, oldest first. */
  async since(after: Cursor): Promise<{ items: ActivityItem[]; gap: boolean }> {
    const w = await this.window();
    const items = w.filter((i) => isNewer(activityCursor(i), after)).reverse();
    const oldest = w[w.length - 1];
    // A full window whose oldest entry is still newer than the cursor means events were missed.
    const gap = w.length > 0 && !!oldest && isNewer(activityCursor(oldest), after) && w.length >= 100;
    return { items, gap };
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const w = await this.window();
      if (!this.seeded) {
        for (const i of w) this.remember(i.id);
        this.seeded = true;
        return;
      }
      const fresh = w.filter((i) => !this.seen.has(i.id)).reverse();
      if (fresh.length === 0) return;
      for (const i of fresh) this.remember(i.id);
      for (const fn of [...this.subs]) fn(fresh);
    } catch {
      // A failed poll is retried on the next tick; subscribers keep their heartbeat.
    } finally {
      this.running = false;
    }
  }

  private remember(id: string) {
    this.seen.add(id);
    if (this.seen.size > this.maxSeen) {
      const first = this.seen.values().next().value;
      if (first !== undefined) this.seen.delete(first);
    }
  }
}
