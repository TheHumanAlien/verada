import { describe, expect, it } from "vitest";
import { sniffImage } from "../src/sniff.js";
import { bytesOf, GIF, JPEG, PNG, SVG, WEBP } from "./helpers.js";

describe("sniffImage", () => {
  it("detects PNG, JPEG and WebP by magic bytes", () => {
    expect(sniffImage(PNG)).toEqual({ mime: "image/png", ext: "png" });
    expect(sniffImage(JPEG)).toEqual({ mime: "image/jpeg", ext: "jpg" });
    expect(sniffImage(WEBP)).toEqual({ mime: "image/webp", ext: "webp" });
  });
  it("rejects SVG, GIF, other RIFF files, truncated and empty input", () => {
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(GIF)).toBeNull();
    expect(sniffImage(bytesOf([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeNull(); // RIFF....WAVE
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(bytesOf([0x89, 0x50, 0x4e, 0x47, 0x00]))).toBeNull(); // PNG prefix, bad tail
  });
});
