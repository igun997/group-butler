import type { ReactNode } from "react";
import Image from "next/image";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, CheckmarkBadge01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatStamp, type PairingStage } from "@/lib/instances";

/** One fact about a linked account. Values are machine strings, so they are mono. */
function IdentityRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs break-all">{value}</dd>
    </div>
  );
}

function PanelHeading({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-medium">{children}</h2>;
}

/**
 * What the pairing flow shows, for whichever stage the worker reports.
 *
 * The panel holds no state and invents no facts: a QR is the worker's data URL
 * rendered as it arrived, a code is the worker's string, and a stopped stage
 * shows the reason with no payload left on screen. `polling`, `checking` and the
 * two actions are the caller's, because it owns the request that drives them.
 */
export function PairingPanel({
  stage,
  polling = false,
  checking = false,
  onCheckNow,
  onRequestCode,
}: {
  stage: PairingStage;
  polling?: boolean;
  checking?: boolean;
  onCheckNow?: () => void;
  onRequestCode?: () => void;
}) {
  const checkingLine = polling ? (
    <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
      <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} className="size-3.5" />
      Checking every 2 seconds
    </p>
  ) : null;

  const checkNow = onCheckNow ? (
    <Button type="button" variant="outline" size="sm" disabled={checking} onClick={onCheckNow} className="max-md:h-11">
      {checking ? <Spinner /> : null}
      Check now
    </Button>
  ) : null;

  const requestCode = onRequestCode ? (
    <Button type="button" variant="outline" size="sm" onClick={onRequestCode} className="max-md:h-11">
      Send a pairing code
    </Button>
  ) : null;

  return (
    <section className="rounded-xl border border-border p-4">
      {stage.kind === "scan" ? (
        <div className="flex flex-col items-center gap-4 text-center">
          <PanelHeading>Scan this with WhatsApp</PanelHeading>
          <p className="max-w-[48ch] text-sm text-muted-foreground">
            On the phone: WhatsApp, Settings, Linked devices, Link a device. The code rotates on its own and this
            panel follows it.
          </p>
          {/* The worker's own data URL, at a size a phone camera can read.
              `unoptimized`: a data URL has nothing for the image optimizer to do,
              and it is regenerated on every rotation anyway. */}
          <Image
            src={stage.qr}
            alt="WhatsApp pairing code"
            width={240}
            height={240}
            unoptimized
            className="size-60 rounded-lg bg-white p-2"
          />
          {checkingLine}
          {checkNow}
        </div>
      ) : null}

      {stage.kind === "code" ? (
        <div className="flex flex-col gap-3">
          <PanelHeading>Enter this code on the phone</PanelHeading>
          <p className="text-sm text-muted-foreground">
            On the phone: WhatsApp, Settings, Linked devices, Link with phone number.
          </p>
          <p className="font-mono text-2xl tracking-widest">{stage.code}</p>
          {checkingLine}
          {checkNow}
        </div>
      ) : null}

      {stage.kind === "waiting" ? (
        <div className="flex flex-col gap-3">
          <PanelHeading>Waiting for the worker</PanelHeading>
          <p className="text-sm text-muted-foreground">
            The worker has not produced a QR or a code yet. This page updates on its own.
          </p>
          {checkingLine}
          {checkNow}
        </div>
      ) : null}

      {stage.kind === "connected" ? (
        <div className="flex flex-col gap-3">
          <PanelHeading>Linked</PanelHeading>
          <p className="flex items-center gap-2 text-sm text-success">
            <HugeiconsIcon icon={CheckmarkBadge01Icon} strokeWidth={2} className="size-4" />
            This account is capturing its groups.
          </p>
          <dl className="divide-y divide-border">
            <IdentityRow label="Phone number" value={stage.identity.phoneNumber} />
            <IdentityRow label="Bot JID" value={stage.identity.botJid} />
            <IdentityRow label="LID" value={stage.identity.botLid} />
            <IdentityRow label="Connected at" value={formatStamp(stage.identity.connectedAt)} />
            <IdentityRow label="Last seen" value={formatStamp(stage.identity.lastSeenAt)} />
          </dl>
        </div>
      ) : null}

      {stage.kind === "stopped" ? (
        <div className="flex flex-col gap-3">
          <PanelHeading>Pairing stopped</PanelHeading>
          <p
            className={
              stage.tone === "failure"
                ? "flex items-start gap-2 text-sm text-destructive"
                : "flex items-start gap-2 text-sm text-muted-foreground"
            }
          >
            {stage.tone === "failure" ? (
              <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="mt-0.5 size-4 shrink-0" />
            ) : null}
            {stage.reason}
          </p>
          {requestCode}
          {checkNow}
        </div>
      ) : null}
    </section>
  );
}
