import { type HTMLAttributes } from 'react';

import { cn } from '../lib/cn';

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-raised text-muted border-border',
  info: 'bg-accent-soft text-accent border-accent/30',
  success: 'bg-success-soft text-success border-success/30',
  warning: 'bg-warning-soft text-warning border-warning/30',
  danger: 'bg-danger-soft text-danger border-danger/30',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/**
 * Status pill. Colour alone never carries meaning — callers pass the state as
 * text content, so the badge stays readable without colour perception.
 */
export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    />
  );
}
