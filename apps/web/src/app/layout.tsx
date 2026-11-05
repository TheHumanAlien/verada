import type { ReactNode } from "react";
import { ConnectButton } from "@/components/connect-button";
import { Nav } from "@/components/nav";
import { Providers } from "@/components/providers";

export const metadata = { title: "Verada" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <Nav />
        </header>
        <Providers>
          <ConnectButton />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
