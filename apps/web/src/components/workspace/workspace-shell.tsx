import { WORKFLOW_STEPS, type WorkflowStepId, type WorkflowStepState } from '@wdrg/contracts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

import { ApiStatus } from './api-status';
import { WorkflowStepper } from './workflow-stepper';

/**
 * Phase 1 state of the workflow: nothing has been created yet, so the first step
 * is available and the rest are locked. Real per-project state replaces this in
 * Phase 2, when projects exist to have state.
 */
const INITIAL_STEP_STATES: Partial<Record<WorkflowStepId, WorkflowStepState>> = {
  'project-details': 'available',
};

const CURRENT_STEP_ID: WorkflowStepId = 'project-details';

/**
 * The single workspace surface.
 *
 * Deliberately one page with panels rather than a multi-page site: the product
 * is one continuous workflow, and a route change between steps would lose
 * in-progress state and break the sense of a single session.
 */
export function WorkspaceShell() {
  const currentStep = WORKFLOW_STEPS.find((step) => step.id === CURRENT_STEP_ID);

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex flex-col gap-0.5">
            <h1 className="text-lg font-semibold">Requirement Documentation Generator</h1>
            <p className="text-sm text-muted">
              From client requirements to an approved, exportable project baseline.
            </p>
          </div>
          <ApiStatus />
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-6 py-8 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <aside aria-labelledby="workflow-heading" className="lg:sticky lg:top-8 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle id="workflow-heading">Workflow</CardTitle>
              <CardDescription>
                Each step unlocks once the previous one is approved.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <WorkflowStepper states={INITIAL_STEP_STATES} currentStepId={CURRENT_STEP_ID} />
            </CardContent>
          </Card>
        </aside>

        <main id="main-content" tabIndex={-1} className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{currentStep?.title ?? 'Project details'}</CardTitle>
              <CardDescription>{currentStep?.summary}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted">
                The project workspace is not available yet. This release establishes the repository,
                the API and this shell; project creation and the requirement intake form arrive in
                the next phase.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What this application produces</CardTitle>
              <CardDescription>
                Seven documents, generated in order, each locked until the previous one is approved.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-2 text-sm sm:grid-cols-2">
                {[
                  'Our Understanding',
                  'Feature Listing',
                  'Acceptance Criteria',
                  'Assumptions',
                  'Statement of Work',
                  'Work Breakdown Structure',
                  'Client Dependency Sheet',
                ].map((document, index) => (
                  <li key={document} className="flex items-baseline gap-2">
                    <span className="text-xs text-muted tabular-nums">{index + 1}.</span>
                    <span>{document}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  );
}
