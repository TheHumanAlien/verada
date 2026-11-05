"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { isAddress, zeroAddress, type Address } from "viem";
import { swarmReferenceToBytes32, TOKEN_TEXT_KEYS } from "@verada/sdk";
import { tokenProfileRegistryAbi } from "@verada/sdk/abis";
import { LogoUploadField } from "@/components/logo-upload";
import { useAppConfig } from "@/components/providers";
import { sameAddress, TxStatus, useTx } from "@/components/use-tx";
import type { TokenProfile } from "@/lib/indexer";
import { parseContenthashInput } from "@/lib/profile";
import type { LogoUpload } from "@/lib/publisher";

const EDITABLE: { key: string; label: string }[] = [
  { key: TOKEN_TEXT_KEYS.description, label: "Description" },
  { key: TOKEN_TEXT_KEYS.url, label: "Website" },
  { key: TOKEN_TEXT_KEYS.twitter, label: "Twitter" },
  { key: TOKEN_TEXT_KEYS.telegram, label: "Telegram" },
  { key: TOKEN_TEXT_KEYS.discord, label: "Discord" },
  { key: TOKEN_TEXT_KEYS.github, label: "GitHub" },
  { key: TOKEN_TEXT_KEYS.avatar, label: "Avatar (URL)" },
];

/** Profile editing for the controller or editor. Each change is one registry transaction. */
export function EditProfilePanel({ token, profile }: { token: Address; profile: TokenProfile | null }) {
  const config = useAppConfig();
  const { address: account } = useAccount();
  const tx = useTx();
  const [texts, setTexts] = useState<Record<string, string>>(profile?.textRecords ?? {});
  const [logo, setLogo] = useState<LogoUpload | null>(null);
  const [contenthash, setContenthash] = useState("");
  const [editor, setEditor] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => setTexts(profile?.textRecords ?? {}), [profile]);

  const isController = sameAddress(account, profile?.controller);
  const isEditor = sameAddress(account, profile?.editor);
  if (!profile || !account || !(isController || isEditor)) return null;
  const registry = config.profileRegistryAddress;

  function send(functionName: "setText" | "setLogoRef" | "setContenthash" | "setEditor", args: readonly unknown[]) {
    setError(undefined);
    if (!registry) return setError("profileRegistryAddress is not configured (config.json)");
    tx.reset();
    void tx
      .send({ address: registry, abi: tokenProfileRegistryAbi, functionName, args: args as never, chainId: config.chainId })
      .catch(() => {});
  }

  function onContenthash(e: FormEvent) {
    e.preventDefault();
    const parsed = parseContenthashInput(contenthash);
    if (!parsed.ok) return setError(parsed.error);
    send("setContenthash", [token, parsed.value]);
  }

  function onEditor(e: FormEvent) {
    e.preventDefault();
    const v = editor.trim();
    if (v !== "" && !isAddress(v)) return setError("Editor must be an address (empty removes the editor)");
    send("setEditor", [token, v === "" ? zeroAddress : v]);
  }

  return (
    <section aria-label="Edit profile">
      <h2>Edit profile</h2>
      <p>You are this token&apos;s profile {isController ? "controller" : "editor"}. Each save is a separate transaction.</p>
      {EDITABLE.map(({ key, label }) => (
        <form
          key={key}
          onSubmit={(e) => {
            e.preventDefault();
            send("setText", [token, key, (texts[key] ?? "").trim()]);
          }}
        >
          <label>
            {label} ({key}) <input value={texts[key] ?? ""} onChange={(e) => setTexts((t) => ({ ...t, [key]: e.target.value }))} />
          </label>{" "}
          <button type="submit" disabled={tx.isPending}>
            Save {label}
          </button>
        </form>
      ))}

      <LogoUploadField onUploaded={setLogo} label="New logo" />
      <button type="button" disabled={!logo || tx.isPending} onClick={() => logo && send("setLogoRef", [token, swarmReferenceToBytes32(logo.reference)])}>
        Set logo
      </button>

      <form onSubmit={onContenthash}>
        <label>
          Contenthash override (bzz://reference, empty to use the default dApp){" "}
          <input value={contenthash} onChange={(e) => setContenthash(e.target.value)} placeholder={profile.contenthash ?? ""} />
        </label>{" "}
        <button type="submit" disabled={tx.isPending}>
          Set contenthash
        </button>
      </form>

      {isController && (
        <form onSubmit={onEditor}>
          <label>
            Editor address (empty to remove) <input value={editor} onChange={(e) => setEditor(e.target.value)} placeholder={profile.editor ?? ""} />
          </label>{" "}
          <button type="submit" disabled={tx.isPending}>
            Set editor
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      <TxStatus tx={tx} label="Profile update" />
    </section>
  );
}
