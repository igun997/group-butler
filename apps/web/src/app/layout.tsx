import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/theme/theme-provider";
import { THEME_SCRIPT } from "@/components/theme/theme-script";
import { TooltipProvider } from "@/components/ui/tooltip";

// One family for the whole console, headings included (DESIGN.md): an interface
// face with matching tabular figures, so numbers in a column line up. The mono is
// the same family, used only for the identifiers the operator copies.
const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: {
    default: "Group Butler",
    template: "%s · Group Butler",
  },
  description: "Operator console for one organisation's WhatsApp groups.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The theme script writes the `dark` class before paint, which is by design
    // a difference between the served markup and the first client render.
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable, geistMono.variable)}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-svh bg-background text-foreground antialiased">
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
