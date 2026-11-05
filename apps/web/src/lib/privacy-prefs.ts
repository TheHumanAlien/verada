/** Per-viewer privacy preferences. Stored only in this browser; every read and write tolerates blocked storage. */
const KEY = "verada:privacy";

export interface PrivacyPrefs {
  /** Also send indexer (Verada API) requests through the anon network, so Verada never sees your IP. */
  routeIndexer: boolean;
}

const DEFAULTS: PrivacyPrefs = { routeIndexer: false };

export function readPrivacyPrefs(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): PrivacyPrefs {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Partial<PrivacyPrefs>;
    return { routeIndexer: v.routeIndexer === true };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writePrivacyPrefs(prefs: PrivacyPrefs, storage: Pick<Storage, "setItem"> | undefined = safeStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // storage blocked: the preference lasts for this page load only
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
