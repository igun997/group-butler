import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Inter, Merriweather } from "next/font/google";
import { cn } from "@/lib/utils";

const merriweatherHeading = Merriweather({subsets:['latin'],variable:'--font-heading'});

const inter = Inter({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: "Group Butler",
  description: "Back end for one organization's WhatsApp group operations.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", inter.variable, merriweatherHeading.variable)}>
      <body>{children}</body>
    </html>
  );
}
