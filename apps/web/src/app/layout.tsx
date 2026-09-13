import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Group Butler",
  description: "Back end for one organization's WhatsApp group operations.",
};

/**
 * The §4 layout is the app root: `<html>`/`<body>`, the UI decision's type and
 * colour tokens (globals.css), and nothing else. The one authenticated shell is
 * not here — it is `app/(dash)/layout.tsx`, the single page shell of
 * docs/ui-decision.md §2.2 invariant 1 — so `/login` and the shell never share
 * chrome.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
