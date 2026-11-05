import { readConfig, type PublisherConfig } from "../src/env.js";

/** In-memory image fixtures: magic bytes followed by filler. No binary files in the repo. */
export const bytesOf = (head: number[], size = 64) => {
  const b = new Uint8Array(Math.max(size, head.length));
  b.set(head);
  return b;
};
export const PNG = bytesOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG = bytesOf([0xff, 0xd8, 0xff, 0xe0]);
export const WEBP = bytesOf([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
export const GIF = bytesOf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
export const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

export const REF = "ab".repeat(32);
export const BATCH = "cd".repeat(32);

export const baseEnv = {
  BEE_GATEWAY_URL: "http://gateway.internal:3000",
  BEE_GATEWAY_AUTH_SECRET: "gateway-secret",
  SWARM_BATCH_ID: BATCH,
  PUBLIC_GATEWAY_URL: "https://gw.verada.xyz",
  RATE_LIMIT_RPS: "100",
  RATE_LIMIT_BURST: "100",
  MAX_LOGO_BYTES: "4096",
  MAX_METADATA_BYTES: "2048",
};

export const config = (over: Record<string, string | undefined> = {}): PublisherConfig => readConfig({ ...baseEnv, ...over });

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const form = (bytes: Uint8Array, name = "logo.png", type = "image/png", field = "file") => {
  const fd = new FormData();
  fd.append(field, new File([bytes as unknown as BlobPart], name, { type }));
  return fd;
};
