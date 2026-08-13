'use client';

import { useQueryClient } from '@tanstack/react-query';
import {
  WORKFLOW_STEPS,
  hasProjectType,
  type ProjectCreatedResponse,
  type ProjectResponse,
  type WorkflowStepId,
  type WorkflowStepState,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useCurrentProject } from '@/hooks/use-project';
import { endProjectSession } from '@/lib/project-api';
import { queryKeys } from '@/lib/query-keys';
import { CreateProjectPanel } from '@/components/project/create-project-panel';
import { DeleteProjectDialog } from '@/components/project/delete-project-dialog';
import { DetailsSection } from '@/components/project/details-section';
import { RecoveryLinkPanel } from '@/components/project/recovery-link-panel';
import { RequirementInputStep } from '@/components/requirements/requirement-input-step';
import { AnalysisStep } from '@/components/analysis/analysis-step';
import { TechnologyStackStep } from '@/components/stack/technology-stack-step';
import { DocumentsStep } from '@/components/documents/documents-step';
import { EstimationStep } from '@/components/estimation/estimation-step';
import { BaselineStep } from '@/components/analysis/baseline-step';
import { ClarificationsStep } from '@/components/analysis/clarifications-step';
import { useSources } from '@/hooks/use-sources';
import { BrandingSection } from '@/components/project/branding-section';
import { OutputPreferencesSection } from '@/components/project/output-preferences-section';
import { StartDateSection } from '@/components/project/start-date-section';
import { TeamCapacitySection } from '@/components/project/team-capacity-section';
import { TimelineSection } from '@/components/project/timeline-section';
import { ApiStatus } from './api-status';
import { WorkflowStepper } from './workflow-stepper';

/**
 * Derives which workflow steps are open.
 *
 * Only the steps this phase implements can be anything but locked. A step whose
 * feature does not exist is shown as locked with a reason, rather than as a
 * button that appears to work and does nothing.
 */
function stepStates(
  project: ProjectResponse | undefined,
  hasReviewedSources: boolean,
): Partial<Record<WorkflowStepId, WorkflowStepState>> {
  if (!project) {
    return { 'project-details': 'available' };
  }

  // The timeline is the one mandatory planning input, so it is what unlocks
  // requirement input. Everything past that stays locked until its phase ships —
  // a step that looks available and does nothing is worse than one marked locked.
  const detailsComplete = Boolean(project.timeline);

  /*
   * Analysis needs *reviewed* content, not merely uploaded content. Unlocking
   * it earlier would offer a button whose only possible outcome is "there is
   * nothing to analyse yet", which teaches users that the workflow lies about
   * what is ready.
   */
  return {
    'project-details': detailsComplete ? 'complete' : 'in_progress',
    'requirement-input': detailsComplete ? 'available' : 'locked',
    'extraction-review': detailsComplete ? 'available' : 'locked',
    'requirement-analysis': hasReviewedSources ? 'available' : 'locked',
    clarifications: hasReviewedSources ? 'available' : 'locked',
    'baseline-approval': hasReviewedSources ? 'available' : 'locked',
    /*
     * Unlocked alongside the analysis steps rather than gated on an approved
     * baseline. The step itself refuses to approve anything without one and says
     * why — which is more useful than a locked tab that explains nothing, and it
     * lets someone record the technologies a client already mandated while the
     * requirements are still being settled.
     */
    'technology-stack': hasReviewedSources ? 'available' : 'locked',
    /*
     * Unlocked with the rest. The step itself refuses to estimate without an
     * approved baseline, a locked stack and a timeline, and says which is
     * missing — more useful than a tab that explains nothing.
     */
    'estimation-timeline': hasReviewedSources ? 'available' : 'locked',
    /*
     * Unlocked with the rest. The step lists every document with the reason each
     * locked one is locked, which is more useful than a tab that explains nothing.
     */
    'document-generation': hasReviewedSources ? 'available' : 'locked',
  };
}

/** The steps this phase implements, in the order the stepper shows them. */
const ANALYSIS_STEPS: readonly WorkflowStepId[] = [
  'requirement-analysis',
  'clarifications',
  'baseline-approval',
  'technology-stack',
  'estimation-timeline',
  'document-generation',
];

export function WorkspaceShell() {
  const queryClient = useQueryClient();
  const { data: project, isPending, isError } = useCurrentProject();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  /**
   * A just-created project, held here until the user confirms they have saved
   * the recovery link.
   *
   * It lives at this level, and takes precedence over everything the query says,
   * because the recovery link is displayed only once and cannot be re-derived. If
   * it were owned by the creation panel, anything that made the workspace decide
   * it had a project — seeding the cache, a refetch on window focus — would
   * unmount that panel and destroy the only copy of the secret.
   */
  const [created, setCreated] = useState<ProjectCreatedResponse | null>(null);

  async function endSession() {
    await endProjectSession();
    queryClient.removeQueries({ queryKey: queryKeys.currentProject });
    setNotice(
      'Your project session has ended. Your recovery link still works — use it to open the project again.',
    );
  }

  const [activeStepId, setActiveStepId] = useState<WorkflowStepId>('project-details');
  const { data: sources } = useSources();
  const hasReviewedSources = Boolean(
    sources?.sources.some((source) => source.reviewStatus === 'REVIEWED'),
  );
  const requirementsUnlocked = Boolean(project?.timeline);
  // Falls back rather than showing a step the project has not earned: clearing
  // the timeline while requirement input is open must not leave it stranded there.
  const analysisLocked = ANALYSIS_STEPS.includes(activeStepId) && !hasReviewedSources;
  const currentStepId: WorkflowStepId =
    (activeStepId === 'requirement-input' && !requirementsUnlocked) || analysisLocked
      ? 'project-details'
      : activeStepId;
  const currentStep = WORKFLOW_STEPS.find((step) => step.id === currentStepId);

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
          <div className="flex flex-wrap items-center gap-3">
            <ApiStatus />
            {project ? (
              <Button variant="secondary" onClick={() => void endSession()}>
                End session
              </Button>
            ) : null}
          </div>
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
            <CardContent className="flex flex-col gap-4">
              <WorkflowStepper
                states={stepStates(project, hasReviewedSources)}
                currentStepId={currentStepId}
              />
              <p className="rounded-md border border-border bg-surface-hover p-3 text-xs text-muted">
                Steps beyond project setup are not built yet. They unlock as later phases ship —
                requirement upload and extraction come next.
              </p>
            </CardContent>
          </Card>

          {project ? (
            <ProjectSidePanel project={project} onDelete={() => setDeleteOpen(true)} />
          ) : null}
        </aside>

        <main id="main-content" tabIndex={-1} className="flex flex-col gap-6">
          {notice ? (
            <Card className="border-accent/40 bg-accent-soft">
              <CardContent className="p-5">
                <p role="status" className="text-sm">
                  {notice}
                </p>
              </CardContent>
            </Card>
          ) : null}

          {isPending && !created ? (
            <Card>
              <CardContent className="p-5">
                <p className="text-sm text-muted">Loading your project…</p>
              </CardContent>
            </Card>
          ) : null}

          {created ? (
            <RecoveryLinkPanel
              recoveryLink={created.recoveryLink}
              requireAcknowledgement
              onAcknowledged={() => {
                queryClient.setQueryData(queryKeys.currentProject, created.project);
                setCreated(null);
              }}
            />
          ) : null}

          {!created && !isPending && (isError || !project) ? (
            <CreateProjectPanel onCreated={setCreated} />
          ) : null}

          {!created && project ? (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>{currentStep?.title}</CardTitle>
                  <CardDescription>{currentStep?.summary}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-3 text-sm">
                  <Badge tone={project.status === 'ACTIVE' ? 'success' : 'info'}>
                    {project.status}
                  </Badge>
                  {!hasProjectType(project.projectTypes) ? (
                    <span className="text-muted">
                      Set a project type below — the technology-stack and estimation steps need it.
                    </span>
                  ) : null}
                </CardContent>
              </Card>

              {currentStepId === 'project-details' ? (
                <>
                  <DetailsSection project={project} />
                  <TimelineSection project={project} />
                  <StartDateSection project={project} />
                  <TeamCapacitySection project={project} />
                  <OutputPreferencesSection project={project} />
                  <BrandingSection project={project} />

                  {requirementsUnlocked ? (
                    <Button
                      className="self-start"
                      onClick={() => setActiveStepId('requirement-input')}
                    >
                      Continue to requirement input
                    </Button>
                  ) : (
                    <p className="text-sm text-muted">
                      Save a delivery timeline to unlock requirement input.
                    </p>
                  )}
                </>
              ) : currentStepId === 'requirement-input' ? (
                <>
                  <Button
                    variant="secondary"
                    className="self-start"
                    onClick={() => setActiveStepId('project-details')}
                  >
                    Back to project details
                  </Button>
                  <RequirementInputStep />
                  {hasReviewedSources ? (
                    <Button
                      className="self-start"
                      onClick={() => setActiveStepId('requirement-analysis')}
                    >
                      Continue to requirement analysis
                    </Button>
                  ) : (
                    <p className="text-sm text-muted">
                      Mark at least one source as reviewed to unlock requirement analysis.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    className="self-start"
                    onClick={() => setActiveStepId('requirement-input')}
                  >
                    Back to requirement input
                  </Button>

                  {currentStepId === 'requirement-analysis' ? <AnalysisStep /> : null}
                  {currentStepId === 'clarifications' ? <ClarificationsStep /> : null}
                  {currentStepId === 'baseline-approval' ? <BaselineStep /> : null}
                  {currentStepId === 'technology-stack' ? <TechnologyStackStep /> : null}
                  {currentStepId === 'estimation-timeline' ? <EstimationStep /> : null}
                  {currentStepId === 'document-generation' ? (
                    <DocumentsStep
                      onAddSupportingSource={() => setActiveStepId('requirement-input')}
                    />
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    {ANALYSIS_STEPS.filter((step) => step !== currentStepId).map((step) => (
                      <Button key={step} variant="secondary" onClick={() => setActiveStepId(step)}>
                        {WORKFLOW_STEPS.find((definition) => definition.id === step)?.title}
                      </Button>
                    ))}
                  </div>
                </>
              )}

              <DeleteProjectDialog
                project={project}
                open={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                onDeleted={() => {
                  setDeleteOpen(false);
                  setNotice('The project has been deleted. Its recovery link no longer works.');
                }}
              />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function ProjectSidePanel({
  project,
  onDelete,
}: {
  project: ProjectResponse;
  onDelete: () => void;
}) {
  // The absolute date only. A "days remaining" countdown would mean reading the
  // clock during render, which is non-deterministic and produces a server/client
  // hydration mismatch — for a date a month away it buys nothing.
  const expires = new Date(project.expiresAt);

  return (
    <Card role="region" aria-labelledby="this-project-title" className="mt-4">
      <CardHeader>
        <CardTitle id="this-project-title">This project</CardTitle>
        <CardDescription>Reference and lifecycle.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">Project ID</span>
          <code className="font-mono text-xs break-all">{project.projectId}</code>
        </div>

        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">Expires</span>
          <time dateTime={project.expiresAt}>{expires.toISOString().slice(0, 10)}</time>
          <span className="text-xs text-muted">
            Opening the project extends this. An expired project can still be read, but not edited.
          </span>
        </div>

        <Button variant="danger" onClick={onDelete} className="self-start">
          Delete project
        </Button>
      </CardContent>
    </Card>
  );
}
