import { toActivity, type ActivityItem, type ActivityKind, type IndexerClient } from "./indexer";

export interface ActivityStreamOptions {
  onItems(items: ActivityItem[]): void;
  /** Called when the transport changes: "sse" or "polling". */
  onMode?(mode: "sse" | "polling"): void;
  pollMs?: number;
  /** Consecutive SSE errors tolerated before dropping to polling. */
  maxSseErrors?: number;
  eventSourceImpl?: typeof EventSource | undefined;
  kind?: ActivityKind;
  token?: string;
}

/**
 * Subscribe to new activity. Uses Server-Sent Events (the browser resumes with
 * Last-Event-ID on reconnect) and falls back to polling /api/activity when SSE
 * is unavailable or keeps failing. Returns an unsubscribe function.
 */
export function subscribeActivity(client: IndexerClient, opts: ActivityStreamOptions): () => void {
  let stopped = false;
  let es: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let errors = 0;
  const seen = new Set<string>();
  let primed = false;

  const emit = (items: ActivityItem[]) => {
    const fresh = items.filter((i) => !seen.has(i.id));
    for (const i of fresh) seen.add(i.id);
    if (fresh.length) opts.onItems(fresh);
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const page = await client.activity({ limit: 20, token: opts.token, kind: opts.kind });
      if (primed) emit(page.items);
      else {
        // First poll only establishes the baseline so history is not replayed as "new".
        for (const i of page.items) seen.add(i.id);
        primed = true;
      }
    } catch {
      // keep polling; the indexer may come back or fail over
    }
    if (!stopped) timer = setTimeout(poll, opts.pollMs ?? 10_000);
  };

  const startPolling = () => {
    opts.onMode?.("polling");
    void poll();
  };

  const ES = opts.eventSourceImpl ?? (typeof EventSource !== "undefined" ? EventSource : undefined);
  if (!ES) {
    startPolling();
  } else {
    const params = new URLSearchParams();
    if (opts.token) params.set("token", opts.token);
    if (opts.kind) params.set("kind", opts.kind);
    const qs = params.size ? `?${params}` : "";
    es = new ES(`${client.streamUrl()}${qs}`);
    opts.onMode?.("sse");
    const handle = (ev: MessageEvent) => {
      errors = 0;
      try {
        const item = toActivity(JSON.parse(String(ev.data)));
        if (item) emit([{ ...item, id: item.id || ev.lastEventId }]);
      } catch {
        // ignore malformed frames
      }
    };
    es.addEventListener("activity", handle as EventListener);
    es.onmessage = handle;
    es.addEventListener("reset", (() => {
      // Resume gap: refetch the latest page and re-baseline.
      void client
        .activity({ limit: 20, token: opts.token, kind: opts.kind })
        .then((page) => {
          if (stopped) return;
          seen.clear();
          for (const i of page.items) seen.add(i.id);
        })
        .catch(() => {});
    }) as EventListener);
    es.onerror = () => {
      errors += 1;
      if (errors >= (opts.maxSseErrors ?? 3) && !stopped) {
        es?.close();
        es = undefined;
        startPolling();
      }
    };
  }

  return () => {
    stopped = true;
    es?.close();
    if (timer) clearTimeout(timer);
  };
}
