import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * The removal surface, both steps. It holds no state of its own: which step is
 * showing belongs to the client wrapper that knows whether a request is in
 * flight, and this component stays something a test can render whole.
 */
export function RemoveInstancePanel({
  label,
  confirming = false,
  pending = false,
  error,
  onStart,
  onCancel,
  onConfirm,
}: {
  label: string;
  confirming?: boolean;
  pending?: boolean;
  error?: string;
  onStart: () => void;
  onCancel?: () => void;
  onConfirm?: () => void;
}) {
  return (
    <section className="rounded-xl border border-destructive/30 p-4">
      <h2 className="text-sm font-medium">Remove instance</h2>

      {confirming ? (
        <>
          <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">
            Removing <span className="text-foreground">{label}</span> deletes its device on the worker and unlinks the
            WhatsApp account. Captured messages, groups and the audit log stay.
          </p>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={onConfirm}
              className="max-md:h-11"
            >
              {pending ? <Spinner /> : null}
              {pending ? "Removing" : "Remove and unlink"}
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={onCancel} className="max-md:h-11">
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">
            Unlinks the WhatsApp account and deletes the worker instance. The stored history is kept.
          </p>
          <div className="mt-3">
            <Button type="button" variant="outline" onClick={onStart} className="max-md:h-11">
              Remove instance
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
