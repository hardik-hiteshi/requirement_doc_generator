/**
 * The public workspace is a single application with a linear workflow. These ids
 * are shared so the API can persist "which step is this project on" using the
 * same vocabulary the UI renders.
 *
 * Phase 1 ships the ids and the ordering only; per-step state machines arrive
 * with the features that own them.
 */
export const WORKFLOW_STEP_IDS = [
  'project-details',
  'requirement-input',
  'extraction-review',
  'requirement-analysis',
  'clarifications',
  'baseline-approval',
  'technology-stack',
  'estimation-timeline',
  'document-generation',
  'export-recovery',
] as const;

export type WorkflowStepId = (typeof WORKFLOW_STEP_IDS)[number];

/** Lifecycle of a single workflow step as presented to the user. */
export const WORKFLOW_STEP_STATES = ['locked', 'available', 'in_progress', 'complete'] as const;

export type WorkflowStepState = (typeof WORKFLOW_STEP_STATES)[number];

export interface WorkflowStepDefinition {
  readonly id: WorkflowStepId;
  readonly order: number;
  readonly title: string;
  /** One-line description of what the user does in this step. */
  readonly summary: string;
}

export const WORKFLOW_STEPS: readonly WorkflowStepDefinition[] = [
  {
    id: 'project-details',
    order: 1,
    title: 'Project details',
    summary: 'Name the project and set the delivery timeline, start date and team capacity.',
  },
  {
    id: 'requirement-input',
    order: 2,
    title: 'Requirement input',
    summary: 'Paste requirement text and upload supporting documents.',
  },
  {
    id: 'extraction-review',
    order: 3,
    title: 'Extraction review',
    summary: 'Review and correct the content extracted from each source.',
  },
  {
    id: 'requirement-analysis',
    order: 4,
    title: 'Requirement analysis',
    summary: 'Inspect modules, features, conflicts, duplicates and gaps.',
  },
  {
    id: 'clarifications',
    order: 5,
    title: 'Clarifications',
    summary: 'Answer targeted questions raised against ambiguities and conflicts.',
  },
  {
    id: 'baseline-approval',
    order: 6,
    title: 'Baseline approval',
    summary: 'Approve the requirement baseline that governs every later document.',
  },
  {
    id: 'technology-stack',
    order: 7,
    title: 'Technology stack',
    summary: 'Select or accept the stack, then lock it as authoritative.',
  },
  {
    id: 'estimation-timeline',
    order: 8,
    title: 'Estimation & timeline',
    summary: 'Review role-wise effort, staffing and the schedule against your deadline.',
  },
  {
    id: 'document-generation',
    order: 9,
    title: 'Document generation',
    summary: 'Generate, review and approve the seven project documents in order.',
  },
  {
    id: 'export-recovery',
    order: 10,
    title: 'Export & recovery',
    summary: 'Export the approved documents and save your private recovery link.',
  },
];

/** Lookup helper so callers never index the array by hand. */
export function getWorkflowStep(id: WorkflowStepId): WorkflowStepDefinition {
  const step = WORKFLOW_STEPS.find((candidate) => candidate.id === id);

  if (!step) {
    throw new Error(`Unknown workflow step: ${id}`);
  }

  return step;
}
