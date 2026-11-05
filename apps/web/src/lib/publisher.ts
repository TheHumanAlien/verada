/**
 * Client for the publisher's upload routes (services/publisher). Requests carry only the file or
 * the metadata document: never a wallet address, cookies or a referrer.
 */

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export interface LogoUpload {
  reference: string;
  bzz: string;
  url: string;
}

export interface MetadataUpload {
  reference: string;
  uri: string;
  url: string;
}

/** `TokenMetadata` as the publisher accepts it (strict: unknown keys are rejected). */
export interface TokenMetadataDocument {
  name: string;
  symbol: string;
  logoRef: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
}

export class PublisherError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PublisherError";
  }
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "The publisher rejected the request",
  413: "File too large (2 MiB at most)",
  415: "Unsupported image type (PNG, JPEG or WebP only)",
  429: "Too many uploads; try again shortly",
  502: "Swarm upload failed upstream; try again",
  503: "Uploads are unavailable right now",
};

/** Client-side precheck; the publisher sniffs the real type from the bytes. */
export function checkLogoFile(file: { size: number; type: string }): string | null {
  if (file.size === 0) return "The file is empty";
  if (file.size > MAX_LOGO_BYTES) return STATUS_MESSAGES[413]!;
  if (file.type && !(LOGO_TYPES as readonly string[]).includes(file.type)) return STATUS_MESSAGES[415]!;
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class PublisherClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly baseUrl: string,
    fetchImpl?: typeof fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl ?? ((...a) => fetch(...a));
  }

  private async post(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch (e) {
      throw new PublisherError(`Publisher unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const code = isRecord(body) && typeof body.error === "string" ? ` (${body.error})` : "";
      throw new PublisherError(`${STATUS_MESSAGES[res.status] ?? `Publisher responded ${res.status}`}${code}`, res.status);
    }
    if (!isRecord(body) || typeof body.reference !== "string") throw new PublisherError("Unexpected publisher response");
    return body;
  }

  async uploadLogo(file: Blob, filename = "logo"): Promise<LogoUpload> {
    const form = new FormData();
    form.append("file", file, filename);
    const b = await this.post("/uploads/logo", { body: form });
    return { reference: String(b.reference), bzz: String(b.bzz ?? `bzz://${b.reference}`), url: String(b.url ?? "") };
  }

  async uploadMetadata(doc: TokenMetadataDocument): Promise<MetadataUpload> {
    const b = await this.post("/uploads/metadata", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doc),
    });
    return { reference: String(b.reference), uri: String(b.uri ?? `bzz://${b.reference}`), url: String(b.url ?? "") };
  }
}
