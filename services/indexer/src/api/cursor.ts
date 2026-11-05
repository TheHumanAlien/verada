import { z } from "zod";

/** Keyset position in a newest-first list: sort value (decimal string) plus a unique tiebreaker. */
export interface Cursor {
  t: string;
  k: string;
}

const CursorSchema = z.object({ t: z.string().regex(/^\d{1,40}$/), k: z.string().min(1).max(200) });

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ t: c.t, k: c.k }), "utf8").toString("base64url");
}

export function decodeCursor(s: string): Cursor | null {
  if (s.length > 400) return null;
  try {
    const parsed = CursorSchema.safeParse(JSON.parse(Buffer.from(s, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Offset cursor for upstream-proxied lists. */
export function encodeOffset(n: number): string {
  return Buffer.from(JSON.stringify({ o: n }), "utf8").toString("base64url");
}

export function decodeOffset(s: string): number | null {
  if (s.length > 100) return null;
  try {
    const p = z.object({ o: z.number().int().min(0).max(100_000) }).safeParse(
      JSON.parse(Buffer.from(s, "base64url").toString("utf8")),
    );
    return p.success ? p.data.o : null;
  } catch {
    return null;
  }
}
