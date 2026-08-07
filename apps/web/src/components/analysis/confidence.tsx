'use client';

import {
  CONFIDENCE_BAND_DESCRIPTIONS,
  CONFIDENCE_BAND_LABELS,
  MODEL_CONFIDENCE_CAVEAT,
  MODEL_CONFIDENCE_LABEL,
  type EvidenceConfidence,
  type ModelConfidence,
} from '@wdrg/contracts';
import { Badge } from '@wdrg/ui';
import { useState } from 'react';

/**
 * Two confidences, shown apart and never merged.
 *
 * This is the most important thing on the requirement screen to get right,
 * because the two numbers mean entirely different things and look identical.
 *
 * The **evidence** score is calculated by the application from traceability and
 * source quality. It is the one that orders review and blocks approval, so it
 * gets the prominent position and an explanation a reviewer can read.
 *
 * The **model's** score is its own opinion of its own output. It is shown
 * because hiding it would be worse, and it is labelled as an AI self-assessment
 * everywhere it appears, with the caveat attached rather than in a footnote — a
 * reader who sees "0.9" and assumes it is a probability has been misled, and
 * putting the correction somewhere else does not undo that.
 */

const BAND_STYLES: Record<EvidenceConfidence['band'], string> = {
  high: 'border-success/30 bg-success-soft text-success',
  medium: 'border-accent/30 bg-accent-soft text-accent',
  low: 'border-warning/30 bg-warning-soft text-warning',
  unsupported: 'border-danger/30 bg-danger-soft text-danger',
};

export function EvidenceConfidenceBadge({
  confidence,
}: {
  readonly confidence: EvidenceConfidence;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${BAND_STYLES[confidence.band]}`}
      >
        <span>{CONFIDENCE_BAND_LABELS[confidence.band]}</span>
        <span aria-hidden="true">·</span>
        <span>{Math.round(confidence.score * 100)}%</span>
        <span className="text-[0.65rem] font-normal">{open ? 'Hide why' : 'Why?'}</span>
      </button>

      {open ? (
        <div className="rounded-md border border-border bg-surface-raised p-3 text-xs">
          <p className="mb-2 text-muted">{CONFIDENCE_BAND_DESCRIPTIONS[confidence.band]}</p>

          {/*
            The score *is* this list. Showing the contributions rather than a
            bare number is what makes the score usable: a reviewer can disagree
            with a specific reason instead of distrusting the whole figure.
          */}
          <ul className="flex flex-col gap-1">
            {confidence.contributions.map((contribution) => (
              <li key={contribution.signal} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className={contribution.weight < 0 ? 'text-danger' : 'text-success'}
                >
                  {contribution.weight < 0 ? '−' : '+'}
                </span>
                <span>{contribution.explanation}</span>
              </li>
            ))}
          </ul>

          <p className="mt-2 text-muted">Calculated from your documents, not by the AI model.</p>
        </div>
      ) : null}
    </div>
  );
}

export function ModelConfidenceNote({ confidence }: { readonly confidence?: ModelConfidence }) {
  if (!confidence) {
    return null;
  }

  return (
    <p className="text-xs text-muted">
      <Badge tone="neutral">{MODEL_CONFIDENCE_LABEL}</Badge>{' '}
      <span>{Math.round(confidence.value * 100)}%</span>{' '}
      {/* The caveat travels with the number. A reader who sees the figure and
          not the warning has been misled, and a footnote does not undo it. */}
      <span className="italic">{MODEL_CONFIDENCE_CAVEAT}</span>
    </p>
  );
}
