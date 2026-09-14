import type { PairingMode } from "@butler/shared";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";

export type CreateInstanceErrors = {
  label?: string;
  phoneNumber?: string;
};

/**
 * The create form's fields, with no state of their own: `mode` decides whether a
 * phone number is asked for, and the caller owns that because the answer is part
 * of the request it is about to send. A missing phone number in `code` mode is
 * the route's `invalid_request`, so the field is required exactly when the route
 * requires it.
 */
export function CreateInstanceFields({
  mode,
  onModeChange,
  errors = {},
  pending = false,
}: {
  mode: PairingMode;
  onModeChange?: (mode: PairingMode) => void;
  errors?: CreateInstanceErrors;
  pending?: boolean;
}) {
  return (
    <FieldGroup>
      <Field data-invalid={errors.label ? true : undefined}>
        <FieldLabel htmlFor="label">Label</FieldLabel>
        <Input
          id="label"
          name="label"
          required
          disabled={pending}
          placeholder="Support bot"
          aria-invalid={errors.label ? true : undefined}
          aria-describedby={errors.label ? "label-error" : undefined}
        />
        <FieldDescription>How this account is named in the console.</FieldDescription>
        {errors.label ? <FieldError id="label-error">{errors.label}</FieldError> : null}
      </Field>

      <Field>
        <FieldTitle>Pairing mode</FieldTitle>
        <RadioGroup
          name="mode"
          value={mode}
          onValueChange={(value) => onModeChange?.(value as PairingMode)}
          disabled={pending}
          className="gap-2"
        >
          <label className="flex items-start gap-3 rounded-xl border border-border p-3">
            <RadioGroupItem value="qr" className="mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Scan a QR code</span>
              <span className="text-xs text-muted-foreground">Link by pointing the phone at this screen.</span>
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-xl border border-border p-3">
            <RadioGroupItem value="code" className="mt-0.5" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Use a phone number</span>
              <span className="text-xs text-muted-foreground">
                WhatsApp sends a pairing code to the number instead.
              </span>
            </span>
          </label>
        </RadioGroup>
      </Field>

      {mode === "code" ? (
        <Field data-invalid={errors.phoneNumber ? true : undefined}>
          <FieldLabel htmlFor="phoneNumber">Phone number</FieldLabel>
          <Input
            id="phoneNumber"
            name="phoneNumber"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            disabled={pending}
            placeholder="628123456789"
            aria-invalid={errors.phoneNumber ? true : undefined}
            aria-describedby={errors.phoneNumber ? "phoneNumber-error" : undefined}
          />
          <FieldDescription>The pair of digits and country code WhatsApp knows. International format, digits only.</FieldDescription>
          {errors.phoneNumber ? <FieldError id="phoneNumber-error">{errors.phoneNumber}</FieldError> : null}
        </Field>
      ) : null}

      <Field>
        <Button type="submit" disabled={pending} className="h-10 w-full max-md:h-12">
          {pending ? <Spinner /> : null}
          {pending ? "Starting pairing" : "Start pairing"}
        </Button>
      </Field>
    </FieldGroup>
  );
}
