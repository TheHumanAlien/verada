"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useAppConfig } from "@/components/providers";
import { checkLogoFile, PublisherClient, type LogoUpload } from "@/lib/publisher";

export type UploadState =
  | { status: "idle" }
  | { status: "uploading"; size: number }
  | { status: "done"; upload: LogoUpload }
  | { status: "error"; message: string };

/**
 * Logo file input that uploads to the publisher as soon as a file is picked. The preview is a local
 * object URL, so nothing is fetched from a gateway before the upload succeeds.
 */
export function LogoUploadField({ onUploaded, label = "Logo (PNG, JPEG or WebP, 2 MiB at most)" }: { onUploaded(upload: LogoUpload | null): void; label?: string }) {
  const config = useAppConfig();
  const publisher = useMemo(() => (config.publisherUrl ? new PublisherClient(config.publisherUrl) : null), [config.publisherUrl]);
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [preview, setPreview] = useState<string>();

  useEffect(() => () => {
    if (preview && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(preview);
  }, [preview]);

  async function onChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    onUploaded(null);
    setPreview(file && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : undefined);
    if (!file) return setState({ status: "idle" });
    if (!publisher) return setState({ status: "error", message: "publisherUrl is not configured (config.json)" });
    const invalid = checkLogoFile(file);
    if (invalid) return setState({ status: "error", message: invalid });
    setState({ status: "uploading", size: file.size });
    try {
      const upload = await publisher.uploadLogo(file, file.name || "logo");
      setState({ status: "done", upload });
      onUploaded(upload);
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Upload failed" });
    }
  }

  return (
    <fieldset>
      <legend>{label}</legend>
      <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => void onChange(e)} aria-label="Logo file" />
      {preview && <img src={preview} alt="Selected logo preview" width={64} height={64} />}
      {state.status === "uploading" && <p role="status">Uploading {Math.ceil(state.size / 1024)} KiB to Swarm</p>}
      {state.status === "done" && (
        <p role="status">
          Uploaded. Swarm reference <code>{state.upload.reference}</code>
        </p>
      )}
      {state.status === "error" && <p role="alert">Logo upload failed: {state.message}</p>}
    </fieldset>
  );
}
