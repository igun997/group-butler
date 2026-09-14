import { Skeleton } from "@/components/ui/skeleton";

/**
 * What the console shows while a page's Mongo and worker reads are in flight.
 * It mirrors the real layout (header, then rows) so the content does not jump
 * when it arrives, and it announces itself once for screen readers.
 */
export default function ConsoleLoading() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <p role="status" className="sr-only">
        Loading
      </p>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-16 w-full rounded-xl" />
      </div>
    </div>
  );
}
