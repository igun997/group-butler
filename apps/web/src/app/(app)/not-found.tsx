import { ButtonLink } from "@/components/shell/button-link";

/**
 * What the console shows for a route that does not resolve inside it, kept
 * inside the shell so the operator can get back to work from here.
 */
export default function ConsoleNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">That is not here</h1>
      <p className="max-w-[65ch] text-sm text-muted-foreground">
        The address does not match anything this console serves, or it names an instance that belongs to another
        organisation.
      </p>
      <div>
        <ButtonLink href="/instances" variant="outline">
          Back to instances
        </ButtonLink>
      </div>
    </div>
  );
}
