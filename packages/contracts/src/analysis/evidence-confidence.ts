import type {
  ConfidenceBand,
  EvidenceConfidence,
  EvidenceContribution,
  EvidenceSignal,
} from './requirement-item.contract';

/**
 * The confidence score that actually governs, calculated here and nowhere else.
 *
 * **The model does not get a vote.** It reports its own confidence, and that
 * number is stored, labelled and shown — but a language model's self-assessment
 * is a token sequence, not a probability, and letting the thing being assessed
 * set its own grade is not a control. This score is computed from facts the
 * application can check: whether a source reference exists, whether the quoted
 * excerpt is really in the cited block, whether that block was located to a page
 * or a row, whether a human has looked at it.
 *
 * Three properties, all deliberate:
 *
 * - **Deterministic.** The same evidence produces the same score, always. A
 *   reviewer who returns tomorrow sees the number they saw today.
 * - **Explainable.** The score *is* its list of contributions. Every one has a
 *   sentence a non-technical reviewer can read, and the total is their sum.
 *   There is no hidden term.
 * - **Versioned.** `ruleVersion` travels with the score, so a value calculated
 *   under old rules can still be interpreted rather than silently compared
 *   against new ones.
 */

export const EVIDENCE_RULE_VERSION = 'v1';

/**
 * What the application knows about one requirement's evidence.
 *
 * Every field is a fact from stored data. Nothing here is asked of the model,
 * and nothing here is an opinion.
 */
export interface EvidenceFacts {
  /** How many source references the item carries. */
  readonly referenceCount: number;
  /** How many of those quoted text that was actually found in the block. */
  readonly verifiedReferenceCount: number;
  /**
   * References whose excerpt was not found verbatim but overlaps the block
   * substantially. Partial support is worth something; it is not worth as much.
   */
  readonly partialReferenceCount: number;
  /** How many references locate the content to a page, row, line or cell. */
  readonly locatedReferenceCount: number;
  /** Distinct documents cited. Two beats one. */
  readonly distinctSourceCount: number;
  /** Whether every cited source has been through human review. */
  readonly allSourcesReviewed: boolean;
  /** Whether any cited block came from OCR rather than a digital text layer. */
  readonly usedOcr: boolean;
  /** Whether any cited block was below the extraction confidence threshold. */
  readonly lowExtractionConfidence: boolean;
  /** Whether an answered clarification supports this requirement. */
  readonly hasConfirmedClarification: boolean;
  /** Whether a person has accepted or edited it. */
  readonly humanReviewed: boolean;
  /** Whether it is part of an open conflict. */
  readonly inOpenConflict: boolean;
  /** Whether it has an open ambiguity finding. */
  readonly hasOpenAmbiguity: boolean;
  /** Whether it cites a source that does not exist in this project. */
  readonly hasUnknownSource: boolean;
}

interface Rule {
  readonly signal: EvidenceSignal;
  readonly weight: number;
  readonly applies: (facts: EvidenceFacts) => boolean;
  readonly explanation: (facts: EvidenceFacts) => string;
}

/**
 * The rules, in the order they are shown.
 *
 * Weights are a judgement, not a measurement, and they are set to a specific
 * shape: **a verified quotation is worth more than everything else combined**,
 * because it is the one signal that cannot be produced by a model inventing
 * something. The rest adjust around it.
 */
const RULES: readonly Rule[] = [
  {
    signal: 'has_source_reference',
    weight: 0.25,
    applies: (facts) => facts.referenceCount > 0,
    explanation: (facts) =>
      facts.referenceCount === 1
        ? 'Links back to a specific place in your documents.'
        : `Links back to ${facts.referenceCount} places in your documents.`,
  },
  {
    signal: 'verbatim_support',
    weight: 0.3,
    applies: (facts) => facts.verifiedReferenceCount > 0,
    explanation: () => 'The quoted wording was found in the document, exactly as cited.',
  },
  {
    signal: 'partial_support',
    weight: 0.12,
    applies: (facts) => facts.verifiedReferenceCount === 0 && facts.partialReferenceCount > 0,
    explanation: () =>
      'The cited text is close to the document’s wording, but not an exact quotation.',
  },
  {
    signal: 'precise_location',
    weight: 0.12,
    applies: (facts) => facts.locatedReferenceCount > 0,
    explanation: () => 'Points to a specific page, row or line, so it can be checked directly.',
  },
  {
    signal: 'multiple_sources',
    weight: 0.1,
    applies: (facts) => facts.distinctSourceCount > 1,
    explanation: (facts) => `Stated in ${facts.distinctSourceCount} separate documents.`,
  },
  {
    signal: 'reviewed_content',
    weight: 0.1,
    applies: (facts) => facts.allSourcesReviewed && facts.referenceCount > 0,
    explanation: () => 'Every document it cites has been checked by a person.',
  },
  {
    signal: 'high_extraction_confidence',
    weight: 0.08,
    applies: (facts) =>
      facts.referenceCount > 0 && !facts.usedOcr && !facts.lowExtractionConfidence,
    explanation: () => 'The text was read directly from the file, not guessed from an image.',
  },
  {
    signal: 'confirmed_clarification',
    weight: 0.1,
    applies: (facts) => facts.hasConfirmedClarification,
    explanation: () => 'Backed by an answer to a clarification question.',
  },
  {
    signal: 'human_accepted',
    weight: 0.15,
    applies: (facts) => facts.humanReviewed,
    explanation: () => 'A person has read this and accepted or corrected it.',
  },

  /* ------------------------------------------------------------ negative */

  {
    signal: 'unverified_excerpt',
    weight: -0.2,
    applies: (facts) =>
      facts.referenceCount > 0 &&
      facts.verifiedReferenceCount === 0 &&
      facts.partialReferenceCount === 0,
    explanation: () =>
      'The quoted wording could not be found in the document it cites. Check this one.',
  },
  {
    signal: 'unreviewed_content',
    weight: -0.15,
    applies: (facts) => facts.referenceCount > 0 && !facts.allSourcesReviewed,
    explanation: () => 'Cites a document whose extracted text has not been checked by a person.',
  },
  {
    signal: 'conflicting_evidence',
    weight: -0.15,
    applies: (facts) => facts.inOpenConflict,
    explanation: () => 'Another requirement contradicts this one, and the conflict is unresolved.',
  },
  {
    signal: 'low_extraction_confidence',
    weight: -0.1,
    applies: (facts) => facts.lowExtractionConfidence,
    explanation: () => 'Some of the text it cites was read with low confidence.',
  },
  {
    signal: 'ocr_sourced',
    weight: -0.08,
    applies: (facts) => facts.usedOcr,
    explanation: () => 'Read from a scanned image rather than a text layer.',
  },
  {
    signal: 'ambiguous_language',
    weight: -0.08,
    applies: (facts) => facts.hasOpenAmbiguity,
    explanation: () => 'Contains wording flagged as open to more than one reading.',
  },
];

/**
 * Calculates the evidence-derived confidence for one requirement.
 *
 * Two facts short-circuit everything, and both mean the same thing: there is
 * nothing to check this requirement against.
 */
export function calculateEvidenceConfidence(
  facts: EvidenceFacts,
  calculatedAt: string,
): EvidenceConfidence {
  if (facts.hasUnknownSource) {
    // The model cited a document this project does not have. Not a low score —
    // no score, because the citation is fiction and a number would dignify it.
    return unsupported(
      'no_source_reference',
      'Cites a document that is not part of this project. The citation could not be checked.',
      calculatedAt,
    );
  }

  if (facts.referenceCount === 0) {
    return unsupported(
      'no_source_reference',
      'Has no link back to any document, so there is nothing to check it against.',
      calculatedAt,
    );
  }

  const contributions: EvidenceContribution[] = RULES.filter((rule) => rule.applies(facts)).map(
    (rule) => ({
      signal: rule.signal,
      weight: rule.weight,
      explanation: rule.explanation(facts),
    }),
  );

  const raw = contributions.reduce((total, contribution) => total + contribution.weight, 0);
  const score = clamp(raw);

  return {
    score,
    band: bandFor(score),
    contributions,
    ruleVersion: EVIDENCE_RULE_VERSION,
    calculatedAt,
  };
}

function unsupported(
  signal: EvidenceSignal,
  explanation: string,
  calculatedAt: string,
): EvidenceConfidence {
  return {
    score: 0,
    band: 'unsupported',
    contributions: [{ signal, weight: 0, explanation }],
    ruleVersion: EVIDENCE_RULE_VERSION,
    calculatedAt,
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}

export function bandFor(score: number): ConfidenceBand {
  if (score >= 0.75) return 'high';
  if (score >= 0.5) return 'medium';
  if (score >= 0.25) return 'low';

  return 'unsupported';
}

export const CONFIDENCE_BAND_LABELS: Readonly<Record<ConfidenceBand, string>> = {
  high: 'Well evidenced',
  medium: 'Reasonably evidenced',
  low: 'Weakly evidenced',
  unsupported: 'Not evidenced',
};

export const CONFIDENCE_BAND_DESCRIPTIONS: Readonly<Record<ConfidenceBand, string>> = {
  high: 'Quoted from a document, in a specific place, and checked.',
  medium:
    'Traceable to a document, with something missing — an exact quotation, a page, or a review.',
  low: 'Traceable, but weakly. Read this one against the source before you rely on it.',
  unsupported:
    'Nothing links this to your documents. It cannot be checked, and it blocks approval.',
};

/** The band below which a requirement stops a baseline being approved. */
export function blocksApproval(band: ConfidenceBand): boolean {
  return band === 'unsupported';
}
