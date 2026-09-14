"use client";

import type { PairingMode } from "@butler/shared";
import { type FormEvent, type MouseEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { ErrorState } from "../../../../components/error-state";
import { trapTabKey } from "../../../../components/focus-trap";
import { useToastOverlay, type MappedError } from "../../../feedback";
import type { CreateInstanceInput } from "./model";

/**
 * The create form: a label, a pairing mode, and — for code pairing — the number
 * the code is sent to (docs/ui-decision.md §2.3, §4.5 R-X2, §4.6, §4.7 R-M5;
 * draft §6.5 `POST /instances`).
 *
 * A form is not a name and a promise: what the operator types is validated here,
 * inline, before anything is sent (R-T5: a form validation failure is the
 * field's own evidence, never a toast), and what the server refuses comes back
 * in the dialog rather than dismissing it (R-X2: a dialog MUST NOT dismiss on
 * failure). Nothing is predicted: the dialog closes when the worker has actually
 * created the row and begun pairing, because the answer is what the next screen
 * shows.
 *
 * It is a native `dialog`, so the top layer, the `Esc` close, the focus
 * containment and the return of focus belong to the platform. While the create
 * is in flight the dialog holds: `Esc` is refused and the controls are disabled,
 * because a request that has already been sent cannot be recalled. And because
 * this is a form the operator types into, it claims the bottom edge for the
 * duration (R-M5), so a notification cannot cover the field being filled in.
 */

/** The two pairing modes, in the operator's words, each with what it does. */
const MODES: readonly { value: PairingMode; label: string; hint: string }[] = [
  { value: "qr", label: "QR code", hint: "The phone holding the account scans a code from this screen." },
  { value: "code", label: "Phone code", hint: "WhatsApp sends a pairing code to the number you enter." },
];

const TOAST_OVERLAY = "create-instance-dialog";

/** What the form is missing, by field. A field with no entry is one this build accepts. */
interface FieldErrors {
  label?: string;
  phoneNumber?: string;
}

function validate(fields: { label: string; mode: PairingMode; phoneNumber: string }): FieldErrors {
  const errors: FieldErrors = {};
  if (fields.label.trim() === "") {
    errors.label = "Give the instance a label. It is the name this dashboard shows for it.";
  }
  if (fields.mode === "code" && fields.phoneNumber.trim() === "") {
    errors.phoneNumber = "Code pairing needs the number WhatsApp sends the code to, in international form.";
  }
  return errors;
}

export interface CreateInstanceDialogProps {
  /** Whether it is open. The caller owns this; the dialog only reflects it. */
  open: boolean;
  /** Whether the create is in flight, which is what holds the dialog. */
  pending: boolean;
  /** The failure of the last attempt, rendered inline (R-X2). */
  failure: MappedError | null;
  onSubmit(input: CreateInstanceInput): void;
  onClose(): void;
}

export function CreateInstanceDialog({ open, pending, failure, onSubmit, onClose }: CreateInstanceDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  const reported = useRef(false);
  const [label, setLabel] = useState("");
  const [mode, setMode] = useState<PairingMode>("qr");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const labelId = useId();
  const phoneId = useId();

  useToastOverlay(TOAST_OVERLAY, open);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      reported.current = false;
      element.showModal();
      labelInput.current?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  /** One dismissal, however it arrived, and never more than one. */
  const dismiss = useCallback((): void => {
    if (reported.current) return;
    reported.current = true;
    dialog.current?.close();
    latest.current();
  }, []);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const cancelled = (event: Event): void => {
      event.preventDefault();
      // A create that has already been sent cannot be recalled, so leaving is
      // refused until it settles — the same rule the confirmation dialog holds.
      if (!pending) dismiss();
    };
    element.addEventListener("cancel", cancelled);
    element.addEventListener("close", dismiss);
    return () => {
      element.removeEventListener("cancel", cancelled);
      element.removeEventListener("close", dismiss);
    };
  }, [dismiss, pending]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const found = validate({ label, mode, phoneNumber });
    setErrors(found);
    if (found.label !== undefined || found.phoneNumber !== undefined) return;
    onSubmit({ label, mode, phoneNumber });
  };

  return (
    <dialog
      ref={dialog}
      className="form-dialog acrylic"
      aria-labelledby={`${labelId}-title`}
      onKeyDown={(event) => trapTabKey(dialog.current, event)}
      onClick={(event: MouseEvent<HTMLDialogElement>) => {
        if (event.target === dialog.current && !pending) dismiss();
      }}
    >
      <form className="form-dialog__form" onSubmit={submit} noValidate>
        <h2 id={`${labelId}-title`} className="form-dialog__title">
          Create instance
        </h2>
        <p className="form-dialog__intro">
          Creating an instance links a WhatsApp account to this dashboard. It starts pairing straight
          away, and the groups it can see arrive after it connects.
        </p>

        <div className="form-dialog__field">
          <label className="form-dialog__label" htmlFor={labelId}>
            Label
          </label>
          <input
            ref={labelInput}
            id={labelId}
            className="form-dialog__input"
            name="label"
            type="text"
            value={label}
            autoComplete="off"
            aria-describedby={errors.label === undefined ? undefined : `${labelId}-error`}
            aria-invalid={errors.label === undefined ? undefined : true}
            onChange={(event) => setLabel(event.target.value)}
          />
          {errors.label === undefined ? null : (
            <p id={`${labelId}-error`} className="form-dialog__error" role="alert">
              {errors.label}
            </p>
          )}
        </div>

        <fieldset className="form-dialog__field">
          <legend className="form-dialog__label">Pairing</legend>
          {MODES.map((option) => (
            <label key={option.value} className="form-dialog__choice">
              <input
                type="radio"
                name="mode"
                value={option.value}
                checked={mode === option.value}
                onChange={() => setMode(option.value)}
              />
              <span className="form-dialog__choice-label">{option.label}</span>
              <span className="form-dialog__choice-hint">{option.hint}</span>
            </label>
          ))}
        </fieldset>

        {mode !== "code" ? null : (
          <div className="form-dialog__field">
            <label className="form-dialog__label" htmlFor={phoneId}>
              Phone number
            </label>
            <input
              id={phoneId}
              className="form-dialog__input"
              name="phoneNumber"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phoneNumber}
              aria-describedby={errors.phoneNumber === undefined ? undefined : `${phoneId}-error`}
              aria-invalid={errors.phoneNumber === undefined ? undefined : true}
              onChange={(event) => setPhoneNumber(event.target.value)}
            />
            {errors.phoneNumber === undefined ? null : (
              <p id={`${phoneId}-error`} className="form-dialog__error" role="alert">
                {errors.phoneNumber}
              </p>
            )}
          </div>
        )}

        {failure === null ? null : <ErrorState error={failure} />}

        <div className="form-dialog__actions">
          <button type="button" className="form-dialog__cancel" onClick={dismiss} disabled={pending}>
            Cancel
          </button>
          <button
            type="submit"
            className="form-dialog__submit"
            aria-busy={pending ? true : undefined}
            disabled={pending}
          >
            {pending ? "Creating…" : "Create and pair"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
