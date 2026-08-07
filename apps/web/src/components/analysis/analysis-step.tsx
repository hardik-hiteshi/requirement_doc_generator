'use client';

import {
  ANALYSIS_FAILURE_MESSAGES,
  ANALYSIS_RUN_STATUS_LABELS,
  isRunFinished,
  type AnalysisRun,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';

import {
  useAnalysisRun,
  useCancelAnalysis,
  useFindings,
  useRequirements,
  useStartAnalysis,
} from '@/hooks/use-analysis';
import { FindingsPanel } from './findings-panel';
import { RequirementList } from './requirement-list';

/**
 * The requirement-analysis step.
 *
 * Its job while the analysis runs is to be honest about the wait. A small model
 * on the operator's own CPU takes minutes, not seconds, and a spinner with no
 * information turns a slow-but-working system into one the user assumes is
 * broken. So the progress shows which chunk of which document is being read,
 * and cancelling is always available.
 */
export function AnalysisStep() {
  const { data: run, isPending } = useAnalysisRun();
  const { data: requirements } = useRequirements();
  const { data: findings } = useFindings();
  const start = useStartAnalysis();
  const cancel = useCancelAnalysis();

  const working = run !== null && run !== undefined && !isRunFinished(run.status);

  return (
    <div className="flex flex-col gap-6">
      <Card role="region" aria-labelledby="analysis-title">
        <CardHeader>
          <CardTitle id="analysis-title">Requirement analysis</CardTitle>
          <CardDescription>
            Your reviewed documents are read by a model running on this deployment’s own hardware.
            Nothing is sent to an outside service.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {isPending ? <p className="text-sm text-muted">Loading…</p> : null}

          {run ? <RunStatus run={run} /> : null}

          <div className="flex flex-wrap gap-2">
            {working ? (
              <Button
                variant="secondary"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(run.id)}
              >
                {cancel.isPending ? 'Stopping…' : 'Stop the analysis'}
              </Button>
            ) : (
              <Button
                disabled={start.isPending}
                onClick={() => start.mutate({ preserveUserDecisions: true })}
              >
                {start.isPending ? 'Starting…' : run ? 'Analyse again' : 'Analyse my requirements'}
              </Button>
            )}
          </div>

          {run && !working ? (
            <p className="text-xs text-muted">
              Running it again keeps every requirement you edited or accepted. A new analysis
              proposes changes; it does not overwrite your decisions.
            </p>
          ) : null}

          {start.isError ? (
            <p role="alert" className="text-sm text-danger">
              {start.error.message}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {findings && requirements ? <FindingsPanel findings={findings} items={requirements} /> : null}

      {requirements && requirements.length > 0 ? <RequirementList items={requirements} /> : null}
    </div>
  );
}

function RunStatus({ run }: { readonly run: AnalysisRun }) {
  const { totalChunks, analysedChunks, failedChunks } = run.progress;
  const done = analysedChunks + failedChunks;
  const percent = totalChunks === 0 ? 0 : Math.round((done / totalChunks) * 100);
  const working = !isRunFinished(run.status);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={
            run.status === 'COMPLETED'
              ? 'success'
              : run.status === 'FAILED'
                ? 'danger'
                : working
                  ? 'info'
                  : 'neutral'
          }
        >
          {ANALYSIS_RUN_STATUS_LABELS[run.status]}
        </Badge>
        <span className="text-xs text-muted">Analysis {run.sequence}</span>
      </div>

      {working && totalChunks > 0 ? (
        <>
          <div
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Analysis progress"
            className="h-2 w-full overflow-hidden rounded-full bg-surface-raised"
          >
            <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-muted">
            {/* Specific, because "please wait" for four minutes reads as broken. */}
            Reading part {done + 1} of {totalChunks}. A model running on your own hardware takes a
            few minutes — you can leave this page and come back.
          </p>
        </>
      ) : null}

      {failedChunks > 0 ? (
        <p className="text-xs text-warning">
          {failedChunks} of {totalChunks} parts could not be analysed. Those parts of your documents
          are marked as not analysed, and that will stop the baseline being approved.
        </p>
      ) : null}

      {run.failureReason ? (
        <p role="alert" className="text-sm text-danger">
          {ANALYSIS_FAILURE_MESSAGES[run.failureReason]}
        </p>
      ) : null}

      {run.status === 'COMPLETED' ? (
        <p className="text-xs text-muted">
          Drafted by <span className="font-medium">{run.model}</span> running on this deployment.
          Every requirement below links to the text it came from.
        </p>
      ) : null}
    </div>
  );
}
