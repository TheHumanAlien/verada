import { Suspense } from "react";
import { TokenDetail } from "@/components/token-detail";

export default function TokenPage() {
  return (
    <Suspense fallback={<p role="status">Loading</p>}>
      <TokenDetail />
    </Suspense>
  );
}
