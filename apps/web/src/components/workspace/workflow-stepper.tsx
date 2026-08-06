import { WORKFLOW_STEPS, type WorkflowStepId, type WorkflowStepState } from '@wdrg/contracts';
import { Badge, cn } from '@wdrg/ui';

const STATE_LABELS: Record<WorkflowStepState, string> = {
  locked: 'Locked',
  available: 'Available',
  in_progress: 'In progress',
  complete: 'Complete',
};

const STATE_TONES = {
  locked: 'neutral',
  available: 'info',
  in_progress: 'warning',
  complete: 'success',
} as const;

export interface WorkflowStepperProps {
  /** Per-step state. Steps not listed default to `locked`. */
  readonly states: Partial<Record<WorkflowStepId, WorkflowStepState>>;
  readonly currentStepId: WorkflowStepId;
}

/**
 * The workflow navigator.
 *
 * Rendered as an ordered list inside a labelled `nav` so a screen-reader user
 * hears the position and total, and marked with `aria-current` so "where am I"
 * is answerable without relying on the colour of a badge.
 */
export function WorkflowStepper({ states, currentStepId }: WorkflowStepperProps) {
  return (
    <nav aria-label="Project workflow">
      <ol className="flex flex-col gap-1">
        {WORKFLOW_STEPS.map((step) => {
          const state = states[step.id] ?? 'locked';
          const isCurrent = step.id === currentStepId;

          return (
            <li key={step.id}>
              <div
                aria-current={isCurrent ? 'step' : undefined}
                className={cn(
                  'flex items-start gap-3 rounded-md border border-transparent px-3 py-2.5',
                  isCurrent && 'border-accent/30 bg-accent-soft',
                  state === 'locked' && !isCurrent && 'opacity-60',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                    state === 'complete'
                      ? 'bg-success text-white'
                      : isCurrent
                        ? 'bg-accent text-accent-foreground'
                        : 'bg-surface-hover text-muted',
                  )}
                >
                  {step.order}
                </span>

                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      <span className="sr-only">{`Step ${step.order} of ${WORKFLOW_STEPS.length}: `}</span>
                      {step.title}
                    </span>
                    <Badge tone={STATE_TONES[state]}>{STATE_LABELS[state]}</Badge>
                  </span>
                  <span className="text-xs text-muted">{step.summary}</span>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
