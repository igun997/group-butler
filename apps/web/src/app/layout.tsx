import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Group Butler",
  description: "Back end for one organization's WhatsApp group operations.",
};

/**
 * The §4 layout is the app root: `<html>`/`<body>`, the UI decision's type and
 * colour tokens (globals.css), and nothing else. No shell chrome is mounted yet
 * because there is no authenticated workspace for it to frame.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
