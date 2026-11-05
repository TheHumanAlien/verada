"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected) {
    return (
      <button type="button" onClick={() => disconnect()}>
        Disconnect {address}
      </button>
    );
  }
  const connector = connectors[0];
  return (
    <button type="button" disabled={!connector} onClick={() => connector && connect({ connector })}>
      Connect wallet
    </button>
  );
}
