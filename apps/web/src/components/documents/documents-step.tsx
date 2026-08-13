'use client';

import {
  CORRECTION_TARGET_LABELS,
  clientDocumentText,
  leaksInternalData,
  DOCUMENT_LABELS,
  DOCUMENT_STATUS_LABELS,
  outdatedExplanation,
  isDocumentEditable,
  technicalDocumentText,
  type DocumentSnapshot,
  type DocumentSummary,
  type DocumentType,
} from '@wdrg/contracts';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import {
  useApplyCorrection,
  useApproveDocument,
  useDocument,
  useDocumentRun,
  useDocuments,
  useGenerateDocument,
  useMarkFinal,
  useReopenDocument,
  useReviseDocument,
} from '@/hooks/use-documents';
import { AssumptionsPanel } from './assumptions-panel';
import { DependencySheet } from './dependency-sheet';
import { TraceabilityPanel } from './traceability-panel';
import { CriteriaTable } from './criteria-table';
import { FeatureTable } from './feature-table';
import { WbsTable } from './wbs-table';
import { SectionEditor } from './section-editor';
import { ExportPanel } from './export-panel';
import { ValidationPanel } from './validation-panel';
import { VersionHistory } from './version-history';

/**
 * The documents step.
 *
 * Two documents work; five are listed as unavailable. Showing them is a decision:
 * a user who can see that a Statement of Work is coming, and that it is not here
 * yet, is better informed than one who sees two cards and wonders whether the
 * product is finished.
 *
 * Everything about a document's state is on the card before it is opened — status,
 * whether it is out of date, whether anything is blocking approval — so nobody has
 * to open three documents to find the one that needs attention.
 */
export function DocumentsStep({
  onAddSupportingSource,
}: {
  /**
   * Sends the user to the requirement-input step.
   *
   * A new source is a *requirement* change, so it goes in where requirements go
   * in: through Phase 3's uploader, Phase 4's analysis and a re-approved baseline.
   * There is deliberately no uploader here — a document-local evidence source
   * would be evidence nothing else in the application had agreed to.
   */
  readonly onAddSupportingSource?: () => void;
} = {}) {
  const documents = useDocuments();
  const [openType, setOpenType] = useState<DocumentType | null>(null);

  const list = documents.data?.documents ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card role="region" aria-label="Documents">
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>
            Built from the requirements you approved, the technologies you locked and the estimate
            you approved. Each one has to be approved before the next unlocks.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {documents.isPending ? <p className="text-sm text-muted">Loading…</p> : null}

          {onAddSupportingSource ? (
            <div className="flex flex-col gap-1 rounded-md border border-border p-3">
              <p className="text-sm">Found something else the client sent?</p>
              <p className="text-xs text-muted">
                It goes in with the requirements, not into a document. We will take you there — once
                it is analysed and the baseline is approved again, every document says it is out of
                date.
              </p>
              <Button
                variant="secondary"
                className="self-start"
                onClick={onAddSupportingSource}
                data-testid="add-supporting-source"
              >
                Add supporting source
              </Button>
            </div>
          ) : null}

          {list.map((summary) => (
            <DocumentCard
              key={summary.type}
              summary={summary}
              open={openType === summary.type}
              onOpen={() => setOpenType(summary.type === openType ? null : summary.type)}
            />
          ))}
        </CardContent>
      </Card>

      {openType ? <DocumentDetail type={openType} /> : null}

      {/*
       * Traceability sits below the list rather than inside a document, because it is
       * the one view that is about all of them at once — and the gaps it finds are
       * invisible from inside any single document.
       */}
      {list.some((summary) => summary.version > 0) ? (
        <TraceabilityPanel onOpen={(type) => setOpenType(type)} />
      ) : null}
    </div>
  );
}

function DocumentCard({
  summary,
  open,
  onOpen,
}: {
  readonly summary: DocumentSummary;
  readonly open: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
      data-testid={`document-card-${summary.type}`}
    >
      <div className="flex flex-col">
        <span className="text-sm font-medium">
          {summary.order}. {summary.label}
        </span>
        <span className="text-xs text-muted">{summary.description}</span>
        {summary.lock ? (
          <span className="mt-1 text-xs text-muted" data-testid={`document-lock-${summary.type}`}>
            {summary.lock.summary}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {summary.currentness === 'OUTDATED' ? (
          <Badge tone="warning" data-testid={`document-outdated-${summary.type}`}>
            Out of date
          </Badge>
        ) : null}
        {/*
         * Both axes, side by side. An issued document that is no longer current
         * keeps saying "Issued" — that is what happened — and says "Out of date"
         * beside it, which is the other thing that happened.
         */}
        <Badge
          tone={
            summary.currentness === 'OUTDATED'
              ? 'warning'
              : summary.status === 'APPROVED' || summary.status === 'FINAL'
                ? 'success'
                : summary.status === 'FAILED'
                  ? 'danger'
                  : 'neutral'
          }
          data-testid={`document-status-${summary.type}`}
        >
          {DOCUMENT_STATUS_LABELS[summary.status]}
        </Badge>
        {/*
         * Locked means "you cannot write this yet", not "you cannot read it". A
         * document that already has a version stays openable even when the step
         * above it has been reopened — an issued document in particular is a record
         * somebody may need to produce, and hiding it behind a disabled button
         * because a prerequisite moved would make the history unreachable exactly
         * when it matters.
         */}
        {summary.implemented ? (
          <Button
            variant="secondary"
            onClick={onOpen}
            disabled={summary.lock?.reason === 'prerequisite_document' && summary.version === 0}
            data-testid={`document-open-${summary.type}`}
          >
            {open ? 'Close' : 'Open'}
          </Button>
        ) : (
          <Badge tone="neutral" data-testid={`document-unavailable-${summary.type}`}>
            Not available yet
          </Badge>
        )}
      </div>
    </div>
  );
}

function DocumentDetail({ type }: { readonly type: DocumentType }) {
  const { data, isPending } = useDocument(type);
  const run = useDocumentRun(type);
  const generate = useGenerateDocument(type);
  const approve = useApproveDocument(type);
  const reopen = useReopenDocument(type);
  const revise = useReviseDocument(type);
  const markFinal = useMarkFinal(type);
  const correction = useApplyCorrection(type);
  const [reason, setReason] = useState('');
  const [instruction, setInstruction] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  /**
   * What the client-facing copy still carried, if anything.
   *
   * A citation prefix is removed for the reviewer. An id written into the middle of
   * their own sentence is not — so the copy still happens, and this says what is in
   * it, rather than a silent rewrite of their words or a silent leak.
   */
  const [copyWarnings, setCopyWarnings] = useState<readonly string[]>([]);

  if (isPending || !data) {
    return <p className="text-sm text-muted">Loading…</p>;
  }

  const document = data.document;
  /*
   * A run recorded against a real provider means inference is configured. With
   * none, every button here still works — the deterministic composition is the
   * path that always runs.
   */
  const aiAvailable = (run.data?.provider ?? 'none') !== 'none' || run.data === null;
  const editable = isDocumentEditable(document.status);

  return (
    <div className="flex flex-col gap-4">
      <Card role="region" aria-label={DOCUMENT_LABELS[type]}>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle data-testid="detail-title">{document.title}</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="neutral" data-testid="document-version">
                v{document.version}
              </Badge>
              <Badge
                tone={
                  document.currentness === 'OUTDATED'
                    ? 'warning'
                    : document.status === 'APPROVED' || document.status === 'FINAL'
                      ? 'success'
                      : 'neutral'
                }
                data-testid="detail-status"
              >
                {DOCUMENT_STATUS_LABELS[document.status]}
              </Badge>
              {document.currentness === 'OUTDATED' ? (
                <Badge tone="warning" data-testid="detail-currentness">
                  Out of date
                </Badge>
              ) : null}
            </div>
          </div>
          <CardDescription>
            {document.baselineVersion !== undefined
              ? `Written against baseline v${document.baselineVersion}`
              : 'Not written yet'}
            {document.estimateVersion !== undefined
              ? `, estimate v${document.estimateVersion}`
              : ''}
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {document.currentness === 'OUTDATED' ? (
            <div className="rounded-md border border-warning p-3" data-testid="outdated-warning">
              <h3 className="text-sm font-medium">
                {document.status === 'FINAL'
                  ? 'This was issued before the project changed'
                  : 'Something it is built on has changed'}
              </h3>
              {outdatedExplanation(document) ? (
                <p className="mt-1 text-sm" data-testid="outdated-explanation">
                  {outdatedExplanation(document)}
                </p>
              ) : null}
              <ul className="mt-2 flex flex-col gap-1 text-sm">
                {document.outdatedReasons.map((reasonEntry, index) => (
                  <li key={`${reasonEntry.cause}-${index}`}>{reasonEntry.summary}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                {document.status === 'FINAL'
                  ? 'Nothing here has been changed. This is the version that was issued, and it stays exactly as it was sent. Start a new version to work against the project as it stands now.'
                  : 'Nothing here has been changed for you. Regenerate it, edit it, or leave it — the decision is yours.'}
              </p>
            </div>
          ) : null}

          {document.blockers.length > 0 ? (
            <div className="rounded-md border border-border p-3" data-testid="document-blockers">
              <h3 className="text-sm font-medium">Before this can be approved</h3>
              <ul className="mt-2 flex flex-col gap-2 text-sm">
                {document.blockers.map((blocker) => (
                  <li key={blocker.kind} data-testid={`blocker-${blocker.kind}`}>
                    <p>{blocker.summary}</p>
                    <p className="text-xs text-muted">{blocker.action}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() =>
                generate.mutate({
                  useAi: false,
                  ...(document.version > 0 &&
                  document.sections.length + document.features.length > 0
                    ? { reason: reason.trim() || 'Regenerated' }
                    : {}),
                  expectedVersion: document.recordVersion,
                })
              }
              disabled={generate.isPending || document.status === 'FINAL'}
              data-testid="generate-without-ai"
            >
              {generate.isPending ? 'Writing…' : 'Write it without AI'}
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                generate.mutate({
                  useAi: true,
                  ...(document.sections.length + document.features.length > 0
                    ? { reason: reason.trim() || 'Regenerated' }
                    : {}),
                  expectedVersion: document.recordVersion,
                })
              }
              disabled={generate.isPending || document.status === 'FINAL'}
              data-testid="generate-with-ai"
            >
              Write it with AI
            </Button>
          </div>

          {generate.isError ? (
            <p role="alert" className="text-sm text-danger" data-testid="generate-error">
              {generate.error.message}
            </p>
          ) : null}

          {/*
           * Approval is offered only where it can succeed. An issued document is a
           * historical record — the API refuses to approve it, and a button that
           * cannot work is worse than no button. Issuing is offered only while the
           * document is current, for the same reason.
           */}
          <div className="flex flex-wrap gap-2">
            {editable ? (
              <Button
                onClick={() =>
                  approve.mutate({ acknowledged: true, expectedVersion: document.recordVersion })
                }
                disabled={
                  approve.isPending ||
                  document.blockers.length > 0 ||
                  document.currentness === 'OUTDATED'
                }
                data-testid="approve-document"
              >
                Approve this document
              </Button>
            ) : null}
            {document.status === 'APPROVED' ? (
              <>
                <Button
                  variant="secondary"
                  data-testid="reopen-document"
                  disabled={reopen.isPending}
                  onClick={() =>
                    reopen.mutate({
                      reason: reason.trim() || 'Reopened for changes',
                      expectedVersion: document.recordVersion,
                    })
                  }
                >
                  Reopen it
                </Button>
                <Button
                  variant="secondary"
                  data-testid="mark-final"
                  disabled={markFinal.isPending || document.currentness === 'OUTDATED'}
                  onClick={() =>
                    markFinal.mutate({
                      acknowledged: true,
                      expectedVersion: document.recordVersion,
                    })
                  }
                >
                  Mark it issued
                </Button>
              </>
            ) : null}
          </div>

          {approve.isError ? (
            <p role="alert" className="text-sm text-danger" data-testid="approve-error">
              {approve.error.message}
            </p>
          ) : null}

          {document.status === 'FINAL' ? (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <p className="text-sm">
                This version has been issued. It cannot be changed — that is what issued means.
              </p>
              <p className="text-xs text-muted">
                Revising starts a new version to work on. The issued one stays exactly as it was
                sent, on the record.
              </p>
              <Button
                variant="secondary"
                className="self-start"
                disabled={revise.isPending}
                data-testid="revise-document"
                onClick={() =>
                  revise.mutate({
                    reason: reason.trim() || 'Revised after issue',
                    expectedVersion: document.recordVersion,
                  })
                }
              >
                Start a new version
              </Button>
            </div>
          ) : null}

          {document.sections.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  data-testid="copy-document"
                  onClick={() => {
                    const text = clientDocumentText({
                      title: document.title,
                      sections: document.sections,
                    });

                    void navigator.clipboard?.writeText(text).then(() => {
                      setCopied('client');
                      setCopyWarnings(leaksInternalData(text));
                    });
                  }}
                >
                  Copy the document
                </Button>
                <Button
                  variant="secondary"
                  data-testid="copy-document-technical"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(
                        technicalDocumentText({
                          title: document.title,
                          sections: document.sections,
                        }),
                      )
                      .then(() => {
                        setCopied('technical');
                        setCopyWarnings([]);
                      });
                  }}
                >
                  Copy with citations
                </Button>
              </div>
              {copied === 'client' && copyWarnings.length > 0 ? (
                <p className="text-xs text-warning" data-testid="copy-warning">
                  The copied text still contains {copyWarnings.join(', ')} — written into the
                  wording itself, so it was left as you wrote it. Edit the section if it should not
                  reach a client.
                </p>
              ) : null}
              <p className="text-xs text-muted" data-testid="copy-note">
                {copied === 'client'
                  ? copyWarnings.length > 0
                    ? 'Copied — check the note above before sending it on.'
                    : 'Copied — headings and text only, nothing internal.'
                  : copied === 'technical'
                    ? 'Copied with the requirement ids, for an internal review.'
                    : 'The plain copy is what a client should see: no requirement ids, no source references, no internal detail.'}
              </p>
            </div>
          ) : null}

          {isDocumentEditable(document.status) &&
          document.sections.length + document.features.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium">Ask for something different</span>
                <span className="text-muted">
                  A request about wording, for {CORRECTION_TARGET_LABELS.DOCUMENT}. It cannot add
                  scope, change a technology or change an hours figure — those are changed in the
                  steps that own them.
                </span>
                <input
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  className="rounded-md border border-border px-2 py-1 text-sm"
                  data-testid="correction-instruction"
                />
              </label>
              <Button
                className="self-start"
                disabled={correction.isPending || instruction.trim().length === 0}
                data-testid="apply-correction"
                onClick={() =>
                  correction.mutate(
                    {
                      instruction: instruction.trim(),
                      targetKind: 'DOCUMENT',
                      useAi: aiAvailable,
                      expectedVersion: document.recordVersion,
                    },
                    { onSuccess: () => setInstruction('') },
                  )
                }
              >
                Apply this correction
              </Button>
              {(correction.data?.limits ?? []).length > 0 ? (
                <ul className="flex flex-col gap-1" data-testid="correction-limits">
                  {(correction.data?.limits ?? []).map((limit) => (
                    <li key={limit} className="text-xs text-warning">
                      {limit}
                    </li>
                  ))}
                </ul>
              ) : null}
              {correction.isError ? (
                <p role="alert" className="text-xs text-danger">
                  {correction.error.message}
                </p>
              ) : null}
            </div>
          ) : null}

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-muted">A note about why, for the record</span>
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="rounded-md border border-border px-2 py-1 text-sm"
              data-testid="document-reason"
            />
          </label>
        </CardContent>
      </Card>

      {document.sections.length > 0 ? (
        <Card role="region" aria-label="Document content">
          <CardHeader>
            <CardTitle>The document</CardTitle>
            <CardDescription>
              Every section can be edited or rewritten. Anything you write is protected from the
              next rewrite — you will be asked before it is replaced.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {document.sections.map((section) => (
              <SectionEditor
                key={section.sectionId}
                type={type}
                section={section}
                recordVersion={document.recordVersion}
                editable={editable}
                aiAvailable={aiAvailable}
              />
            ))}
          </CardContent>
        </Card>
      ) : null}

      {document.features.length > 0 || document.coverage ? (
        <FeatureTable type={type} document={document} />
      ) : null}

      {/*
       * The structured list documents. Each renders its own rows: an acceptance
       * criterion and an assumption are different things to read and different
       * things to decide about, so they get different views over the one row
       * channel the engine stores them in.
       */}
      {type === 'ACCEPTANCE_CRITERIA' && (document.rows.length > 0 || document.criteriaCoverage) ? (
        <CriteriaTable
          type={type}
          document={document}
          editable={editable}
          aiAvailable={aiAvailable}
        />
      ) : null}

      {type === 'ASSUMPTIONS' && document.assumptionSummary ? (
        <AssumptionsPanel
          type={type}
          document={document}
          editable={editable}
          aiAvailable={aiAvailable}
        />
      ) : null}

      {type === 'WORK_BREAKDOWN_STRUCTURE' &&
      (document.rows.length > 0 || document.wbsReconciliation) ? (
        <WbsTable type={type} document={document} editable={editable} aiAvailable={aiAvailable} />
      ) : null}

      {type === 'CLIENT_DEPENDENCY_SHEET' &&
      (document.rows.length > 0 || document.dependencySummary) ? (
        <DependencySheet type={type} document={document} editable={editable} />
      ) : null}

      <ValidationPanel type={type} document={document} aiAvailable={aiAvailable} />
      <ExportPanel type={type} document={document} />
      <VersionHistory type={type} document={document} />
    </div>
  );
}

/** Re-exported so the workspace shell imports one name. */
export type { DocumentSnapshot };
