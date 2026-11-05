export interface Cache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown, ttlMs: number): void;
}

export class MemoryCache implements Cache {
  private store = new Map<string, { value: unknown; expires: number }>();
  constructor(private now: () => number = Date.now) {}
  get(key: string): unknown | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }
  set(key: string, value: unknown, ttlMs: number): void {
    this.store.set(key, { value, expires: this.now() + ttlMs });
  }
}
