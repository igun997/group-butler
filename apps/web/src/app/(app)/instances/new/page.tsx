import type { Metadata } from "next";
import Link from "next/link";
import { CreateInstanceForm } from "@/components/instances/create-instance-form";
import { requireOwner } from "@/server/auth/require";

export const metadata: Metadata = { title: "Link an account" };

export default async function NewInstancePage() {
  await requireOwner();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/instances"
          className="w-fit text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          All instances
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Link a WhatsApp account</h1>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          One instance is one linked account. Pairing finishes on the next screen: the worker produces a QR or a code
          and the console follows it there.
        </p>
      </header>
      <CreateInstanceForm />
    </div>
  );
}
