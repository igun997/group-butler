import type { MessageRow } from "@/server/repos/messages";
import { MediaLink } from "./media-link";
import { RawMessageViewer } from "./raw-message-viewer";

const STAMP_FORMATTER = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

function labelForMediaStatus(status: string, reason: string | null): string {
  if (status === "ready") return "Attachment available";
  if (reason) return `Attachment could not be read: ${reason.replaceAll("_", " ")}`;
  return status === "none" ? "No attachment" : `Attachment status: ${status.replaceAll("_", " ")}`;
}

function stamp(value: string | null): string {
  if (value === null) return "Time unavailable";
  return STAMP_FORMATTER.format(new Date(value)) + " UTC";
}

export function MessageTranscript({ messages, filtered = false }: { messages: readonly MessageRow[]; filtered?: boolean }) {
  if (messages.length === 0) {
    return (
      <section className="rounded-xl border border-dashed border-border px-4 py-8 text-center" aria-live="polite">
        <h2 className="text-sm font-medium">{filtered ? "No messages match these filters" : "No captured messages yet"}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {filtered ? "Change the search or scope to see other captured messages." : "Messages appear here after the linked account captures group activity."}
        </p>
      </section>
    );
  }

  return (
    <ol className="flex min-w-0 flex-col gap-3" aria-label="Messages, oldest first">
      {messages.map((message) => {
        const sender = message.pushName.trim() || message.senderJid;
        const mediaLabel = labelForMediaStatus(message.media.status, message.media.reason);
        return (
          <li key={`${message.instanceId}:${message.waMessageId}`} className={`flex min-w-0 ${message.fromMe ? "justify-end" : "justify-start"}`}>
            <article className={`min-w-0 max-w-full rounded-xl border px-3 py-2 sm:max-w-[80%] ${message.fromMe ? "border-primary/30 bg-primary/10" : "border-border bg-card"}`}>
              <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                <strong className="text-foreground">{sender}</strong>
                {message.pushName.trim() ? <span className="font-mono break-all text-muted-foreground">{message.senderJid}</span> : null}
                <span className="text-muted-foreground">{message.fromMe ? "Sent" : "Received"}</span>
                <time className="text-muted-foreground" dateTime={message.timestamp ?? undefined}>{stamp(message.timestamp)}</time>
              </header>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm">{message.text || "No text captured."}</p>
              <footer className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>Kind: {message.kind}</span>
                {message.media.status !== "none" ? <span>{mediaLabel}</span> : null}
                {message.media.fileName ? <span className="font-mono break-all">{message.media.fileName}</span> : null}
                {message.media.r2Key ? <MediaLink instanceId={message.instanceId} messageId={message.waMessageId} /> : null}
              </footer>
              <RawMessageViewer instanceId={message.instanceId} messageId={message.waMessageId} />
            </article>
          </li>
        );
      })}
    </ol>
  );
}
