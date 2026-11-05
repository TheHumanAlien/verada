"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useAccount } from "wagmi";
import { parseEventLogs, type Address } from "viem";
import { EXTERNAL_ADDRESSES, isValidLabel, labelFromSymbol, ONDO_TOKENS } from "@verada/sdk";
import { factoryAbi } from "@/lib/abis";
import { chainLabelStatus, type LabelStatus } from "@/lib/chain-reads";
import { ensGatewayUrl } from "@/lib/host";
import {
  buildMetadataDocument,
  EMPTY_METADATA_FIELDS,
  MAX_FEE_BPS,
  MIN_FEE_BPS,
  parseLaunchInput,
  type LaunchInput,
  type MetadataFields,
} from "@/lib/launch";
import { PublisherClient, type LogoUpload } from "@/lib/publisher";
import { AppLink } from "@/components/nav";
import { FocusPicker } from "@/components/catalog-browser";
import { LogoUploadField } from "@/components/logo-upload";
import { useAppConfig, useDeps } from "@/components/providers";
import { errorText, sameAddress, TxStatus, useTx } from "@/components/use-tx";

const initial: LaunchInput = {
  name: "",
  symbol: "",
  label: "",
  logoRef: "",
  metadataURI: "",
  salt: "",
  baseFeeBps: String(MIN_FEE_BPS),
  sniperFeeStartBps: "0",
  sniperDecaySeconds: "0",
  startTick: "0",
  quoteAsset: EXTERNAL_ADDRESSES.weth,
  categories: [],
  regions: [],
};

const ONDO_BY_ADDRESS = new Map<string, string>(Object.entries(ONDO_TOKENS).map(([sym, t]) => [t.address.toLowerCase(), sym]));

// Used when the indexer has no quote-asset list; the factory still rejects anything not allowlisted.
const SUGGESTED_QUOTES = (["NVDAon", "TSLAon", "SPYon", "QQQon"] as const).map((k) => ({ label: k, address: ONDO_TOKENS[k].address as string }));

function quoteLabel(address: string): string {
  if (address.toLowerCase() === EXTERNAL_ADDRESSES.weth.toLowerCase()) return "WETH";
  return ONDO_BY_ADDRESS.get(address.toLowerCase()) ?? address;
}

type MetaState = { status: "idle" } | { status: "uploading" } | { status: "done"; uri: string } | { status: "error"; message: string };

export function LaunchForm() {
  const config = useAppConfig();
  const deps = useDeps();
  const { address: account } = useAccount();
  const [input, setInput] = useState<LaunchInput>(initial);
  const [labelEdited, setLabelEdited] = useState(false);
  const [fields, setFields] = useState<MetadataFields>(EMPTY_METADATA_FIELDS);
  const [logo, setLogo] = useState<LogoUpload | null>(null);
  const [meta, setMeta] = useState<MetaState>({ status: "idle" });
  const [error, setError] = useState<string | undefined>();
  const [launchedLabel, setLaunchedLabel] = useState<string>();
  const tx = useTx();

  // The label follows the symbol until the creator edits it.
  useEffect(() => {
    if (!labelEdited) setInput((prev) => ({ ...prev, label: labelFromSymbol(prev.symbol) ?? "" }));
  }, [input.symbol, labelEdited]);

  const [debouncedLabel, setDebouncedLabel] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedLabel(input.label.trim()), 400);
    return () => clearTimeout(t);
  }, [input.label]);

  const labelStatus = useQuery({
    queryKey: ["label-status", config.profileRegistryAddress, debouncedLabel],
    queryFn: () => chainLabelStatus(deps.chain(), config, debouncedLabel),
    enabled: isValidLabel(debouncedLabel),
    retry: false,
    staleTime: 15_000,
  });

  // The governor rejects a launch whose focus pool (latest catalogue) has fewer than two orgs.
  const pool = useQuery({
    queryKey: ["catalog-pool", input.categories.join(","), input.regions.join(",")],
    queryFn: () => deps.indexer.catalogPool(input.categories, input.regions),
    retry: false,
    staleTime: 300_000,
  });

  const quotes = useQuery({ queryKey: ["quote-assets"], queryFn: () => deps.indexer.quoteAssets(), retry: false, staleTime: 300_000 });
  const quoteOptions = useMemo(() => {
    const listed = (quotes.data ?? []).filter((q) => q.active).map((q) => ({ label: quoteLabel(q.asset), address: q.asset }));
    const others = (listed.length ? listed : SUGGESTED_QUOTES).filter((q) => q.address.toLowerCase() !== EXTERNAL_ADDRESSES.weth.toLowerCase());
    return [{ label: "WETH", address: EXTERNAL_ADDRESSES.weth as string }, ...others];
  }, [quotes.data]);

  const set = (key: keyof LaunchInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setInput((prev) => ({ ...prev, [key]: e.target.value }));
  const setField = (key: keyof MetadataFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFields((prev) => ({ ...prev, [key]: e.target.value }));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    tx.reset();
    if (!config.factoryAddress) return setError("factoryAddress is not configured (config.json)");
    const parsed = parseLaunchInput({ ...input, logoRef: logo?.reference ?? "" });
    if (!parsed.ok) return setError(parsed.error);
    if (typeof pool.data === "number" && pool.data < 2) {
      return setError("The chosen causes and regions hold fewer than two organizations; widen the focus");
    }
    const status = labelStatus.data;
    if (status && (status.kind === "taken" || (status.kind === "reserved" && !sameAddress(status.allowedCreator, account)))) {
      return setError(`The label "${parsed.params.label}" is not available`);
    }

    let metadataURI = parsed.params.metadataURI;
    if (!metadataURI && logo) {
      if (!config.publisherUrl) return setError("publisherUrl is not configured (config.json)");
      const doc = buildMetadataDocument(parsed.params, logo.reference, fields);
      if (!doc.ok) return setError(doc.error);
      setMeta({ status: "uploading" });
      try {
        metadataURI = (await new PublisherClient(config.publisherUrl).uploadMetadata(doc.doc)).uri;
        setMeta({ status: "done", uri: metadataURI });
      } catch (err) {
        const message = errorText(err);
        setMeta({ status: "error", message });
        return setError(`Metadata upload failed: ${message}`);
      }
    }

    try {
      setLaunchedLabel(parsed.params.label);
      await tx.send({
        address: config.factoryAddress,
        abi: factoryAbi,
        functionName: "deployToken",
        args: [{ ...parsed.params, metadataURI }],
        chainId: config.chainId,
      });
    } catch {
      // shown through tx.error
    }
  }

  const launched = useMemo(() => {
    if (!tx.receipt || tx.receipt.status !== "success") return null;
    const [log] = parseEventLogs({ abi: factoryAbi, eventName: "TokenCreated", logs: tx.receipt.logs });
    return (log?.args as { token?: Address } | undefined)?.token ?? null;
  }, [tx.receipt]);

  const label = input.label.trim();
  const ensName = isValidLabel(label) ? `${label}.${config.ensParentName}` : null;

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <p>
        <label>
          Name <input value={input.name} onChange={set("name")} required />
        </label>
      </p>
      <p>
        <label>
          Symbol <input value={input.symbol} onChange={set("symbol")} required />
        </label>
      </p>
      <p>
        <label>
          ENS label{" "}
          <input
            value={input.label}
            onChange={(e) => {
              setLabelEdited(true);
              set("label")(e);
            }}
            aria-describedby="label-status"
          />
        </label>
      </p>
      <p id="label-status" role="status">
        {ensName ? <LabelLine name={ensName} status={labelStatus.data} loading={labelStatus.isFetching} error={labelStatus.error} account={account} /> : label ? "Label must be 3 to 63 characters of a-z, 0-9 and hyphens" : "Pick a label"}
      </p>

      <LogoUploadField onUploaded={setLogo} />

      <fieldset>
        <legend>Profile (stored in the metadata document on Swarm)</legend>
        <p>
          <label>
            Description <textarea value={fields.description} onChange={setField("description")} maxLength={2000} />
          </label>
        </p>
        <p>
          <label>
            Website <input value={fields.website} onChange={setField("website")} type="url" placeholder="https://" />
          </label>
        </p>
        <p>
          <label>
            Twitter <input value={fields.twitter} onChange={setField("twitter")} />
          </label>
        </p>
        <p>
          <label>
            Telegram <input value={fields.telegram} onChange={setField("telegram")} />
          </label>
        </p>
        <p>
          <label>
            Discord <input value={fields.discord} onChange={setField("discord")} />
          </label>
        </p>
        {!logo && <p role="note">The metadata document is uploaded once a logo is uploaded. Without a logo, the metadata URI below is used as is.</p>}
      </fieldset>

      <fieldset aria-label="Cause focus">
        <legend>Cause focus</legend>
        <p>
          Every charity in the catalogue that matches the causes and regions you tick is eligible: holders vote each week on a ballot
          drawn in rotation from all of them. The focus can never change after launch.
        </p>
        <FocusPicker
          categories={input.categories}
          regions={input.regions}
          onChange={(f) => setInput((prev) => ({ ...prev, categories: f.categories, regions: f.regions }))}
        />
        {pool.isLoading && <p role="status">Counting eligible organizations</p>}
        {typeof pool.data === "number" && (
          <p role={pool.data < 2 ? "alert" : undefined}>
            {pool.data} eligible catalogue entr{pool.data === 1 ? "y" : "ies"}
            {pool.data < 2 ? ": at least two are needed to launch" : ""}
          </p>
        )}
        {pool.data === null && <p role="note">The cause catalogue is not available; the factory still checks the focus on chain.</p>}
      </fieldset>

      <p>
        <label>
          Quote asset{" "}
          <select value={input.quoteAsset} onChange={set("quoteAsset")}>
            {quoteOptions.map((o) => (
              <option key={o.address} value={o.address}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p>
        <label>
          Base fee (bps, {MIN_FEE_BPS} to {MAX_FEE_BPS}) <input value={input.baseFeeBps} onChange={set("baseFeeBps")} inputMode="numeric" />
        </label>
      </p>
      <details>
        <summary>Advanced</summary>
        <p>
          <label>
            Sniper fee start (bps) <input value={input.sniperFeeStartBps} onChange={set("sniperFeeStartBps")} inputMode="numeric" />
          </label>
        </p>
        <p>
          <label>
            Sniper decay (seconds) <input value={input.sniperDecaySeconds} onChange={set("sniperDecaySeconds")} inputMode="numeric" />
          </label>
        </p>
        <p>
          <label>
            Start tick <input value={input.startTick} onChange={set("startTick")} inputMode="numeric" />
          </label>
        </p>
        <p>
          <label>
            Metadata URI override (skips the metadata upload) <input value={input.metadataURI} onChange={set("metadataURI")} />
          </label>
        </p>
        <p>
          <label>
            Salt (optional, 32-byte hex) <input value={input.salt} onChange={set("salt")} />
          </label>
        </p>
      </details>

      <button type="submit" disabled={tx.isPending || meta.status === "uploading"}>
        {meta.status === "uploading" ? "Uploading metadata" : tx.isPending ? "Confirm in wallet" : "Launch token"}
      </button>
      {meta.status === "done" && <p role="status">Metadata stored at {meta.uri}</p>}
      {error && <p role="alert">{error}</p>}
      <TxStatus tx={tx} label="Launch" />
      {launched && (
        <p>
          Launched: <AppLink to={`token/?address=${launched}`}>token page</AppLink>
          {launchedLabel && (
            <>
              {" "}
              and <a href={ensGatewayUrl(launchedLabel, config.ensParentName)}>{`${launchedLabel}.${config.ensParentName}`}</a>
            </>
          )}
        </p>
      )}
    </form>
  );
}

function LabelLine({ name, status, loading, error, account }: { name: string; status?: LabelStatus; loading: boolean; error: unknown; account?: Address }) {
  if (loading && !status) return <>Checking {name}</>;
  if (error) return <>{name}: availability unknown ({errorText(error)})</>;
  switch (status?.kind) {
    case "available":
      return <>{name} is available</>;
    case "taken":
      return <>{name} is taken (token {status.token})</>;
    case "reserved":
      return sameAddress(status.allowedCreator, account) ? <>{name} is reserved for your address</> : <>{name} is reserved</>;
    case "unknown":
      return <>{name}: availability unknown ({status.reason})</>;
    default:
      return <>{name}</>;
  }
}
