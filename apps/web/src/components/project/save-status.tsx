import { Badge } from '@wdrg/ui';

import type { SaveState } from '@/hooks/use-project';

export interface SaveStatusProps {
  readonly state: SaveState;
  readonly message?: string;
}

/**
 * Save state for one section.
 *
 * Announced politely rather than assertively: a save confirmation should not
 * interrupt whatever a screen-reader user is currently reading, but it must
 * reach them. The status text is always rendered as text, never colour alone.
 */
export function SaveStatus({ state, message }: SaveStatusProps) {
  if (state === 'idle') {
    return <span role="status" aria-live="polite" className="sr-only" />;
  }

  const presentation: Record<
    Exclude<SaveState, 'idle'>,
    { tone: 'neutral' | 'success' | 'warning' | 'danger'; label: string }
  > = {
    saving: { tone: 'neutral', label: 'Saving…' },
    saved: { tone: 'success', label: 'Saved' },
    conflict: { tone: 'warning', label: 'Changed elsewhere' },
    error: { tone: 'danger', label: 'Not saved' },
  };

  const { tone, label } = presentation[state];

  return (
    <span role="status" aria-live="polite" className="flex items-center gap-2">
      <Badge tone={tone}>{label}</Badge>
      {message ? <span className="text-xs text-muted">{message}</span> : null}
    </span>
  );
}
