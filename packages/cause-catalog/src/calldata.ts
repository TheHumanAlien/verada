import { encodeFunctionData, parseAbi, type Hex } from "viem";

export const causeCatalogSetVersionAbi = parseAbi([
  "function setVersion(bytes32 root, uint32[] bucketSizes, bytes32 swarmRef) returns (uint32 version)",
]);

/** Calldata for `CauseCatalog.setVersion`. Printed for the owner to sign; never sent from here. */
export function setVersionCalldata(root: Hex, bucketSizes: number[], swarmRef: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(swarmRef)) throw new Error("swarm reference must be 32 bytes (unencrypted)");
  return encodeFunctionData({ abi: causeCatalogSetVersionAbi, functionName: "setVersion", args: [root, bucketSizes, swarmRef] });
}
