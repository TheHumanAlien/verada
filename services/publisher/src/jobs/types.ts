export type Log = (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => void;

/** A periodic background job. `run` must be idempotent: a run may be retried or overlap a deploy. */
export interface Job {
  name: string;
  /** Minimum time between runs. */
  intervalMs: number;
  run(): Promise<void>;
}

/** Arkiv blocks are 2 s, so 30 days is 1,296,000 blocks. */
export const ARKIV_BLOCK_SECONDS = 2;
export const RENEW_BEFORE_BLOCKS = BigInt((30 * 86_400) / ARKIV_BLOCK_SECONDS);
