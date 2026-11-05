import { agentVaultAbi, curatorRegistryAbi } from "@verada/sdk/abis";
import { encodeFunctionData, type Hex } from "viem";
import type { BuiltReport } from "./build.js";

/** `CuratorRegistry.submitCurations` for every region of a built report. */
export function submitCurationsCalldata(b: BuiltReport, reportRef: Hex): Hex {
  return encodeFunctionData({
    abi: curatorRegistryAbi,
    functionName: "submitCurations",
    args: [
      b.categoryBit,
      BigInt(b.report.epoch),
      b.report.catalogVersion,
      reportRef,
      b.regions.map((r) => ({ regionBit: r.regionBit, picksRoot: r.picksRoot, count: r.count, weight: r.weight })),
    ],
  });
}

/** `AgentVault.give` with the org's catalogue proof. */
export function giveCalldata(regionBit: number, orgId: Hex, catalogIndex: number, proof: Hex[], amount: bigint): Hex {
  return encodeFunctionData({ abi: agentVaultAbi, functionName: "give", args: [regionBit, orgId, catalogIndex, proof, amount] });
}
