import type { ComponentProps, ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ButtonLinkProps = VariantProps<typeof buttonVariants> & {
  href: string;
  className?: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof Link>, "href" | "className" | "children">;

/**
 * A link that looks like a button, and is a link.
 *
 * It is not `<Button render={<Link/>}>` on purpose. base-ui's `Button` is a
 * button: with its `nativeButton` default it warns about the non-`<button>` it was
 * handed, and even when told `nativeButton={false}` it keeps `role="button"` and
 * `tabindex="0"` on the anchor. A control that navigates should announce as a
 * link, so this applies the button's *styles* to a real anchor, which keeps the
 * variants in one place without borrowing the semantics.
 */
export function ButtonLink({ href, variant, size, className, children, ...props }: ButtonLinkProps) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant, size }), className)} {...props}>
      {children}
    </Link>
  );
}
