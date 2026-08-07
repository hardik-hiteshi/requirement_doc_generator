import { isClientEvidence, type StackEvidenceKind } from './stack-component.contract';

/**
 * How well-founded a technology choice is, computed by this application.
 *
 * Phase 4's rule, carried forward without amendment. The model reports how
 * confident it feels; that number is labelled, shown, and decides nothing. This
 * number is a sum of named signals over stored facts, and it is the one that
 * orders the review queue and feeds approval.
 *
 * The reason is unchanged too. A model's confidence is a statement about the
 * model. *"Three approved requirements name this and one of them is a
 * confirmed clarification"* is a statement about the project — and it is the
 * second that tells a reviewer where to spend their attention.
 *
 * ## Every score is arithmetic somebody can check
 *
 * `calculateStackEvidence` returns the contributions alongside the total, and
 * the UI shows them. A number a user cannot reconstruct is a number they end up
 * either ignoring or trusting blindly, and both are worse than no number.
 */

export const STACK_EVIDENCE_RULE_VERSION = 'v1';

/** What is known about one technology choice, as stored. */
export interface StackEvidenceFacts {
  readonly evidenceKind: StackEvidenceKind;
  /** Approved requirement ids naming or implying this. Verified to exist. */
  readonly requirementIds: readonly string[];
  /** Confirmed clarification keys behind it. */
  readonly clarificationKeys: readonly string[];
  /** A requirement names this technology outright. */
  readonly mandatedByRequirement: boolean;
  /** A stated project constraint — hosting, budget, compliance — leads here. */
  readonly satisfiesStatedConstraint: boolean;
  /** The user chose it themselves. */
  readonly userSelected: boolean;
  /** Chosen from the reviewed catalogue rather than typed. */
  readonly inCatalog: boolean;
  /** An unresolved compatibility finding names it. */
  readonly hasOpenConflict: boolean;
  /** Infrastructure facts a decision would need, which nobody supplied. */
  readonly missingInfrastructureContext: boolean;
}

export interface StackEvidenceRule {
  readonly id: string;
  readonly weight: number;
  /** Shown to the user, in their terms. */
  readonly label: string;
  readonly applies: (facts: StackEvidenceFacts) => boolean;
}

/**
 * The signals, and what each is worth.
 *
 * Weights are deliberately coarse. The score exists to sort a review queue and
 * to answer *"is this founded on anything?"*, not to express a fine-grained
 * belief that the underlying facts could not support anyway.
 *
 * Two are negative. A choice caught in an unresolved contradiction, or made
 * without the infrastructure facts it needed, is *less* well-founded than one
 * that is merely unremarkable — and a score that could only go up would say the
 * opposite.
 */
export const STACK_EVIDENCE_RULES: readonly StackEvidenceRule[] = [
  {
    id: 'explicit_mandate',
    weight: 0.4,
    label: 'A requirement names this technology',
    applies: (facts) => facts.mandatedByRequirement,
  },
  {
    id: 'client_requirement',
    weight: 0.2,
    label: 'An approved requirement leads here',
    applies: (facts) => isClientEvidence(facts.evidenceKind) && facts.requirementIds.length > 0,
  },
  {
    id: 'confirmed_clarification',
    weight: 0.15,
    label: 'A confirmed clarification supports it',
    applies: (facts) => facts.clarificationKeys.length > 0,
  },
  {
    id: 'multiple_requirements',
    weight: 0.1,
    label: 'More than one requirement points the same way',
    applies: (facts) => facts.requirementIds.length > 1,
  },
  {
    id: 'stated_constraint',
    weight: 0.1,
    label: 'It satisfies a constraint you stated',
    applies: (facts) => facts.satisfiesStatedConstraint,
  },
  {
    id: 'user_decision',
    weight: 0.15,
    label: 'You chose it',
    applies: (facts) => facts.userSelected,
  },
  {
    id: 'reviewed_catalog_entry',
    weight: 0.05,
    label: 'A reviewed catalogue entry backs the facts shown',
    applies: (facts) => facts.inCatalog,
  },
  {
    id: 'open_conflict',
    weight: -0.25,
    label: 'An unresolved compatibility problem involves it',
    applies: (facts) => facts.hasOpenConflict,
  },
  {
    id: 'missing_context',
    weight: -0.15,
    label: 'Information this decision needs was never supplied',
    applies: (facts) => facts.missingInfrastructureContext,
  },
];

export interface StackEvidenceContribution {
  readonly ruleId: string;
  readonly label: string;
  readonly weight: number;
}

export interface StackEvidenceResult {
  /** 0–1, clamped. The sum of the contributions below. */
  readonly score: number;
  readonly band: StackEvidenceBand;
  readonly contributions: readonly StackEvidenceContribution[];
  readonly ruleVersion: string;
}

export const STACK_EVIDENCE_BANDS = ['unsupported', 'weak', 'moderate', 'strong'] as const;
export type StackEvidenceBand = (typeof STACK_EVIDENCE_BANDS)[number];

export const STACK_EVIDENCE_BAND_LABELS: Readonly<Record<StackEvidenceBand, string>> = {
  unsupported: 'Nothing supports this',
  weak: 'Thinly supported',
  moderate: 'Reasonably supported',
  strong: 'Well supported',
};

export const STACK_EVIDENCE_BAND_DESCRIPTIONS: Readonly<Record<StackEvidenceBand, string>> = {
  unsupported:
    'Nothing in your approved requirements leads to this choice, and you have not made it yourself.',
  weak: 'Something points this way, but not much. Worth a look before you approve.',
  moderate: 'Your requirements or your own decision support this.',
  strong: 'Several independent things point here.',
};

/** Band thresholds. A choice nobody made and nothing implies scores zero. */
export function stackEvidenceBandFor(score: number): StackEvidenceBand {
  if (score <= 0.05) {
    return 'unsupported';
  }

  if (score < 0.25) {
    return 'weak';
  }

  if (score < 0.55) {
    return 'moderate';
  }

  return 'strong';
}

export function calculateStackEvidence(facts: StackEvidenceFacts): StackEvidenceResult {
  const contributions = STACK_EVIDENCE_RULES.filter((rule) => rule.applies(facts)).map((rule) => ({
    ruleId: rule.id,
    label: rule.label,
    weight: rule.weight,
  }));

  const raw = contributions.reduce((total, contribution) => total + contribution.weight, 0);
  const score = Math.max(0, Math.min(1, Number(raw.toFixed(4))));

  return {
    score,
    band: stackEvidenceBandFor(score),
    contributions,
    ruleVersion: STACK_EVIDENCE_RULE_VERSION,
  };
}

/**
 * The plain-language explanation shown beside the score.
 *
 * Built from the contributions rather than written separately, so the sentence
 * and the number cannot disagree.
 */
export function explainStackEvidence(result: StackEvidenceResult): string {
  if (result.contributions.length === 0) {
    return 'Nothing was found that supports or undermines this choice.';
  }

  const positive = result.contributions.filter((contribution) => contribution.weight > 0);
  const negative = result.contributions.filter((contribution) => contribution.weight < 0);
  const parts: string[] = [];

  if (positive.length > 0) {
    parts.push(positive.map((contribution) => contribution.label.toLowerCase()).join('; '));
  }

  if (negative.length > 0) {
    parts.push(
      `against that: ${negative.map((contribution) => contribution.label.toLowerCase()).join('; ')}`,
    );
  }

  return `${parts.join('. ')}.`;
}
