/** Image types the logo upload accepts. SVG is never accepted (it can carry script). */
export type ImageType = { mime: "image/png" | "image/jpeg" | "image/webp"; ext: "png" | "jpg" | "webp" };

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);

/**
 * Detects the image type from magic bytes only; the client's declared type and file name are
 * ignored. PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, WebP `RIFF....WEBP`.
 */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, PNG)) return { mime: "image/png", ext: "png" };
  if (startsWith(bytes, JPEG)) return { mime: "image/jpeg", ext: "jpg" };
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return { mime: "image/webp", ext: "webp" };
  return null;
}
