import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

import { cn } from '../lib/cn';

export interface FieldProps {
  readonly label: string;
  /** Guidance shown under the label. Linked via aria-describedby. */
  readonly hint?: string;
  /** Validation message. Linked via aria-describedby and marks the control invalid. */
  readonly error?: string;
  readonly required?: boolean;
  readonly children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
    'aria-required': boolean | undefined;
  }) => ReactNode;
}

/**
 * Label, hint and error wired to a control by id.
 *
 * The wiring is the point: a visually adjacent error message that is not
 * referenced by `aria-describedby` is invisible to a screen reader, which is the
 * most common way a form that "looks accessible" is not. Doing it in one place
 * means no call site can forget.
 */
export function Field({ label, hint, error, required, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
        {required ? (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        ) : (
          <span className="ml-2 text-xs font-normal text-muted">(optional)</span>
        )}
      </label>

      {hint ? (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
      })}

      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const controlClasses =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground ' +
  'placeholder:text-muted outline-none transition-colors ' +
  'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 ' +
  'disabled:cursor-not-allowed disabled:opacity-60 ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/30';

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(controlClasses, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(controlClasses, 'min-h-24 resize-y', className)} {...props} />;
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly label: string;
  readonly description?: string;
}

export function Checkbox({ label, description, className, ...props }: CheckboxProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        aria-describedby={descriptionId}
        className={cn(
          'mt-0.5 size-4 shrink-0 rounded border-border text-accent',
          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
          className,
        )}
        {...props}
      />
      <span className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-sm text-foreground">
          {label}
        </label>
        {description ? (
          <span id={descriptionId} className="text-xs text-muted">
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}
