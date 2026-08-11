import { z } from 'zod';

/**
 * Whether a document is fit to be approved, and why not.
 *
 * ## Deterministic checks are authoritative
 *
 * Every finding below is produced by arithmetic over stored data: does this
 * requirement id exist, is this requirement rejected, does this hours figure
 * match the approved estimate, is this baseline the current one. A model may
 * *add* findings — an unsupported claim reads like prose and a checker cannot
 * see it — but it can never clear one, and it can never downgrade one. A model
 * that could turn a BLOCKING finding into a warning would be a model that can
 * approve a document.
 *
 * ## Three severities, and only one of them stops you
 *
 * `BLOCKING` prevents approval. `WARNING` is something a person should read and
 * may accept — acknowledging is recorded, which is the point. `PASS` entries are
 * kept rather than discarded, because "we checked coverage and it was complete"
 * is a more useful record than a silent absence.
 */

export const VALIDATION_SEVERITIES = ['PASS', 'WARNING', 'BLOCKING'] as const;
export type ValidationSeverity = (typeof VALIDATION_SEVERITIES)[number];
export const validationSeveritySchema = z.enum(VALIDATION_SEVERITIES);

/**
 * What was checked.
 *
 * Deterministic first, then the two a model contributes to. The split is not
 * cosmetic: `detectedBy` records which one found each finding, and a reader can
 * tell a fact from a judgement.
 */
export const VALIDATION_KINDS = [
  /** A referenced requirement id is not in this project's baseline. */
  'unknown_requirement',
  /** A requirement the analysis rejected appears in the document. */
  'rejected_requirement_present',
  /** A superseded requirement appears instead of the item that replaced it. */
  'superseded_requirement_present',
  /** The document was written against a baseline that is no longer current. */
  'stale_baseline',
  /** An approved requirement is neither represented nor explicitly excluded. */
  'requirement_uncovered',
  /** A blocking analysis or estimation issue is not visible in the document. */
  'hidden_blocker',
  /** Two rows, or a row and a section, describe the same thing. */
  'duplicate_content',
  /** A module or submodule hierarchy that contradicts itself. */
  'inconsistent_hierarchy',
  /** An hours figure that does not match the approved estimate. */
  'effort_mismatch',
  /** A row cites an estimate unit that does not exist. */
  'unknown_estimate_reference',
  /** A row cites a technology that is not in the locked stack. */
  'unknown_technology_reference',
  /** Scope and out-of-scope statements that contradict each other. */
  'scope_contradiction',
  /** A section is empty and has no reason recorded. */
  'empty_section',
  /* ---- Phase 8: Acceptance Criteria ---- */
  /** A criterion cites a feature that is not in the current Feature Listing. */
  'unknown_feature_reference',
  /** A criterion states a figure or standard the approved evidence does not. */
  'unstated_threshold',
  /** A criterion exists for scope somebody deliberately excluded. */
  'criterion_for_excluded_scope',
  /** An approved feature has no acceptance criterion and no disposition. */
  'feature_uncovered',
  /** A criterion cites nothing, so nothing supports it. */
  'criterion_unsupported',
  /** A criterion a person added without saying where it came from. */
  'attribution_missing',
  /* ---- Phase 8: Assumptions ---- */
  /** An assumption with no provenance a person stands behind. */
  'assumption_unprovenanced',
  /** A model's candidate is still waiting for somebody to decide. */
  'assumption_unconfirmed',
  /** Two confirmed assumptions that cannot both be true. */
  'assumption_contradiction',
  /** An unresolved clarification has been treated as though it were answered. */
  'open_question_as_assumption',
  /** A confirmed assumption whose failure would stop the plan. */
  'assumption_blocking_unresolved',
  /* ---- Phase 8: Statement of Work ---- */
  /** The SOW's scope does not reconcile with the approved Feature Listing. */
  'scope_not_reconciled',
  /** A technology that is not in the locked stack, or a version that differs. */
  'stack_mismatch',
  /** A timeline that is not the approved one, or a date nobody approved. */
  'timeline_mismatch',
  /** A legal or commercial term nobody supplied. */
  'unsupported_legal_term',
  /** Internal delivery methodology in a client document. */
  'internal_methodology_disclosed',
  /** A staffing commitment the approved capacity plan does not establish. */
  'fictional_staffing',
  /** A deliverable that traces to nothing approved. */
  'unsupported_deliverable',
  /** An assumption in the SOW that is not in the approved Assumptions document. */
  'assumption_not_approved',
  /** Acceptance wording that contradicts the approved Acceptance Criteria. */
  'acceptance_misaligned',
  /** A statement with no supporting requirement. Model-assisted. */
  'unsupported_statement',
  /** The same concept named two ways. Model-assisted. */
  'terminology_inconsistency',
] as const;

export type ValidationKind = (typeof VALIDATION_KINDS)[number];

/** Who found it. A judgement is labelled as one. */
export const DETECTED_BY = ['DETERMINISTIC', 'MODEL'] as const;
export type DetectedBy = (typeof DETECTED_BY)[number];

/**
 * Findings a model is allowed to raise.
 *
 * Anything outside this set is an arithmetic question, and a model's opinion
 * about arithmetic is not wanted. Enforced when model output is folded in.
 */
export const MODEL_RAISABLE_KINDS: readonly ValidationKind[] = [
  'unsupported_statement',
  'terminology_inconsistency',
  'scope_contradiction',
  'duplicate_content',
];

export const validationFindingSchema = z
  .object({
    kind: z.enum(VALIDATION_KINDS),
    severity: validationSeveritySchema,
    detectedBy: z.enum(DETECTED_BY),
    /** One sentence stating the problem. */
    summary: z.string().min(1).max(400),
    /** What to do about it. Empty for a PASS. */
    action: z.string().max(400),
    /** Sections, rows or requirements concerned. */
    subjectIds: z.array(z.string().max(64)).max(200),
    /** Set when a warning has been read and accepted. */
    acknowledgedAt: z.string().datetime().optional(),
  })
  .strict();

export type ValidationFinding = z.infer<typeof validationFindingSchema>;

export const documentValidationSchema = z
  .object({
    validationId: z.string().min(1).max(64),
    /** Document version this result belongs to. A later edit invalidates it. */
    documentVersion: z.number().int().nonnegative(),
    ranAt: z.string().datetime(),
    /** Worst severity present. `PASS` when nothing was found. */
    severity: validationSeveritySchema,
    findings: z.array(validationFindingSchema).max(400),
    /** Whether a model contributed. False when AI is unavailable. */
    modelAssisted: z.boolean(),
  })
  .strict();

export type DocumentValidation = z.infer<typeof documentValidationSchema>;

/** The worst severity in a set of findings. */
export function worstSeverity(findings: readonly ValidationFinding[]): ValidationSeverity {
  if (findings.some((finding) => finding.severity === 'BLOCKING')) {
    return 'BLOCKING';
  }

  if (findings.some((finding) => finding.severity === 'WARNING' && !finding.acknowledgedAt)) {
    return 'WARNING';
  }

  return 'PASS';
}

/**
 * Whether validation permits approval.
 *
 * A blocking finding refuses, always. An unacknowledged warning does not refuse
 * — it is a warning, and treating it as a gate would train people to acknowledge
 * without reading.
 */
export function validationPermitsApproval(validation: DocumentValidation | null): boolean {
  if (!validation) {
    return false;
  }

  return !validation.findings.some((finding) => finding.severity === 'BLOCKING');
}

/** Whether a stored validation still describes the document in front of you. */
export function validationIsCurrent(
  validation: DocumentValidation | null,
  documentVersion: number,
): boolean {
  return validation !== null && validation.documentVersion === documentVersion;
}

export const acknowledgeFindingSchema = z
  .object({
    kind: z.enum(VALIDATION_KINDS),
    /** Explicit, and never defaulted — see the estimation contract for why. */
    acknowledged: z.literal(true),
    note: z.string().max(1_000).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type AcknowledgeFinding = z.infer<typeof acknowledgeFindingSchema>;
