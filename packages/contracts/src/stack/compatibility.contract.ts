import { z } from 'zod';

import type { ProjectType } from '../project/project-type.contract';
import {
  allowsMultiple,
  technologyCategorySchema,
  type TechnologyCategory,
} from './technology-category.contract';
import { fillsCategory, suitsProjectType, type CatalogEntry } from './technology-catalog.contract';
import { impliesSpend } from './technology-catalog.contract';

/**
 * What is wrong with a stack, decided by rules rather than by a model.
 *
 * A compatibility finding is a claim about the world — *"pgvector is a
 * PostgreSQL extension and you have chosen MySQL"* — and a claim that came out
 * of a small language model is a claim nobody checked. Every finding produced
 * here comes from a catalogue fact or a stated constraint, so the same stack
 * always produces the same findings and each one can be traced to the entry that
 * caused it.
 *
 * The model may *add* observations, and they are labelled as its own. It cannot
 * remove a finding from here, and it cannot manufacture one: `BLOCKING` is
 * reachable only through these rules.
 *
 * ## Severity means what it says
 *
 * `BLOCKING` is reserved for two things: a direct contradiction with a
 * mandatory requirement, and a combination that cannot be built. Not "we would
 * not do it this way", not "this will be slow". Everything softer is `HIGH` at
 * most — and a `HIGH` finding does not override the user. They acknowledge it,
 * it is carried into the estimate and the documents, and the work proceeds with
 * their choice.
 */

export const RISK_LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'BLOCKING'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];
export const riskLevelSchema = z.enum(RISK_LEVELS);

export const RISK_LEVEL_LABELS: Readonly<Record<RiskLevel, string>> = {
  NONE: 'No concern',
  LOW: 'Worth knowing',
  MEDIUM: 'Worth discussing',
  HIGH: 'Needs your acknowledgement',
  BLOCKING: 'Cannot be approved',
};

export const RISK_RANK: Readonly<Record<RiskLevel, number>> = Object.fromEntries(
  RISK_LEVELS.map((level, index) => [level, index]),
) as Record<RiskLevel, number>;

/** Findings at or above this level must be acknowledged before approval. */
export const ACKNOWLEDGEMENT_THRESHOLD: RiskLevel = 'HIGH';

export function needsAcknowledgement(level: RiskLevel): boolean {
  return RISK_RANK[level] >= RISK_RANK[ACKNOWLEDGEMENT_THRESHOLD] && level !== 'BLOCKING';
}

export function isBlocking(level: RiskLevel): boolean {
  return level === 'BLOCKING';
}

/** What kind of problem this is. Each maps to exactly one rule below. */
export const COMPATIBILITY_FINDING_KINDS = [
  /** The technology does not belong in the category it was put in. */
  'category_mismatch',
  /** The catalogue says these two cannot be combined. */
  'mutual_incompatibility',
  /** Two technologies doing the same job in a single-slot category. */
  'duplicate_responsibility',
  /** Not a sensible choice for this kind of project. */
  'unsupported_project_type',
  /** Contradicts a technology a requirement mandates by name. */
  'mandate_contradiction',
  /** A hosted service where the requirements demand self-hosting. */
  'self_hosting_violation',
  /** Spend where the requirements state there is to be none. */
  'budget_violation',
  /** Data leaves the client where a requirement says it must not. */
  'data_residency_concern',
  /** No longer maintained. */
  'deprecated_technology',
  /** Real operational weight, worth naming before it is committed to. */
  'operational_burden',
  /** A licence with obligations a delivery team should see first. */
  'licence_concern',
  /** A required category with nothing in it. */
  'missing_required_category',
  /** Present without anything in the requirements asking for it. */
  'unjustified_category',
] as const;

export type CompatibilityFindingKind = (typeof COMPATIBILITY_FINDING_KINDS)[number];
export const compatibilityFindingKindSchema = z.enum(COMPATIBILITY_FINDING_KINDS);

export const compatibilityFindingSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: compatibilityFindingKindSchema,
    level: riskLevelSchema,
    /** Categories involved, so the UI can attach it to the right rows. */
    categories: z.array(technologyCategorySchema).max(6),
    /** Component ids involved. */
    componentIds: z.array(z.string().max(64)).max(6),
    /** What is wrong, in the user's terms. */
    summary: z.string().min(1).max(400),
    /** What it means for delivery, if they keep it. */
    impact: z.string().max(600),
    /** What they could do. Never phrased as an instruction to comply. */
    suggestion: z.string().max(600),
    /** Requirement ids that make this a contradiction rather than an opinion. */
    requirementIds: z.array(z.string().max(64)).max(20),
    /**
     * True when a rule in this file produced it.
     *
     * A model observation is `false`, is never `BLOCKING`, and is displayed as
     * the model's opinion rather than as a finding.
     */
    deterministic: z.boolean(),
  })
  .strict();

export type CompatibilityFinding = z.infer<typeof compatibilityFindingSchema>;

/* ------------------------------------------------------- the constraints */

/**
 * Constraints the project states, gathered from the approved baseline and from
 * what the user entered.
 *
 * Each carries the requirement ids behind it, because a constraint with no
 * evidence cannot make anything blocking — it is a preference, and preferences
 * do not stop approval.
 */
export interface StackConstraints {
  /** Everything must run on infrastructure the client controls. */
  readonly selfHostedOnly: boolean;
  readonly selfHostedEvidence: readonly string[];
  /** No per-use or licence spend on third-party services. */
  readonly noRecurringSpend: boolean;
  readonly noSpendEvidence: readonly string[];
  /** Client data may not leave a jurisdiction or the client's estate. */
  readonly dataResidency: boolean;
  readonly dataResidencyEvidence: readonly string[];
  /**
   * Technologies a requirement names outright.
   *
   * Resolved to a catalogue entry before it gets here, so the rule knows which
   * slot the mandate is about. A mandate for something not in the catalogue is
   * still recorded on the component; it just cannot contradict anything
   * automatically, because nothing here knows what it is.
   */
  readonly mandates: readonly TechnologyMandate[];
}

export interface TechnologyMandate {
  readonly technologyId: string;
  readonly technologyName: string;
  readonly category: TechnologyCategory;
  /** Approved requirement ids that state it. Without these it is a preference. */
  readonly requirementIds: readonly string[];
}

export const EMPTY_CONSTRAINTS: StackConstraints = {
  selfHostedOnly: false,
  selfHostedEvidence: [],
  noRecurringSpend: false,
  noSpendEvidence: [],
  dataResidency: false,
  dataResidencyEvidence: [],
  mandates: [],
};

/* --------------------------------------------------------- the rules */

/** One component, reduced to what the rules need. */
export interface ComponentFacts {
  readonly id: string;
  readonly category: TechnologyCategory;
  readonly technologyName: string;
  /** Absent for a custom technology, which carries no reviewed facts. */
  readonly entry: CatalogEntry | undefined;
  /** Whether it holds a live position, as opposed to rejected or superseded. */
  readonly active: boolean;
}

export interface CompatibilityInput {
  readonly projectTypes: readonly ProjectType[];
  readonly components: readonly ComponentFacts[];
  readonly constraints: StackConstraints;
  /** Required categories from the project-type plan. */
  readonly requiredCategories: readonly TechnologyCategory[];
  /** Conditional categories with at least one requirement justifying them. */
  readonly justifiedCategories: readonly TechnologyCategory[];
}

/**
 * Every deterministic finding for a stack.
 *
 * Pure, total and order-stable: the same input produces the same findings in the
 * same order, which is what lets a test assert them and a reviewer trust that
 * nothing changed underneath them between two visits to the screen.
 */
export function evaluateCompatibility(input: CompatibilityInput): readonly CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];
  const active = input.components.filter((component) => component.active);
  const push = (finding: Omit<CompatibilityFinding, 'id' | 'deterministic'>): void => {
    findings.push({
      ...finding,
      id: `${finding.kind}:${[...finding.componentIds, ...finding.categories].join('+')}`,
      deterministic: true,
    });
  };

  /* --- the technology is not what the category asked for --- */
  for (const component of active) {
    if (component.entry && !fillsCategory(component.entry, component.category)) {
      push({
        kind: 'category_mismatch',
        level: 'BLOCKING',
        categories: [component.category],
        componentIds: [component.id],
        summary: `${component.technologyName} is not a ${categoryWord(component.category)}.`,
        impact: 'The stack as written cannot be built, because this slot has nothing in it.',
        suggestion: `Choose a ${categoryWord(component.category)}, or move ${component.technologyName} to the category it belongs in.`,
        requirementIds: [],
      });
    }
  }

  /* --- the catalogue says these two cannot go together --- */
  for (const first of active) {
    for (const second of active) {
      if (first.id >= second.id || !first.entry || !second.entry) {
        continue;
      }

      // Read symmetrically: an incompatibility declared on either entry counts,
      // so the catalogue states each fact once rather than twice.
      const clash =
        first.entry.incompatibleWith.find((rule) => rule.technologyId === second.entry?.id) ??
        second.entry.incompatibleWith.find((rule) => rule.technologyId === first.entry?.id);

      if (clash) {
        push({
          kind: 'mutual_incompatibility',
          level: 'BLOCKING',
          categories: [first.category, second.category],
          componentIds: [first.id, second.id],
          summary: `${first.technologyName} and ${second.technologyName} cannot be used together.`,
          impact: clash.reason,
          suggestion: 'Change one of them.',
          requirementIds: [],
        });
      }
    }
  }

  /* --- two things doing one job --- */
  const byCategory = new Map<TechnologyCategory, ComponentFacts[]>();

  for (const component of active) {
    const held = byCategory.get(component.category) ?? [];

    held.push(component);
    byCategory.set(component.category, held);
  }

  for (const [category, held] of byCategory) {
    if (held.length > 1 && !allowsMultiple(category)) {
      push({
        kind: 'duplicate_responsibility',
        level: 'BLOCKING',
        categories: [category],
        componentIds: held.map((component) => component.id),
        summary: `${held.map((component) => component.technologyName).join(' and ')} are both filling the ${categoryWord(category)} slot.`,
        impact: 'A project has one of these. Two is a decision that was never made.',
        suggestion: 'Keep one and remove the other.',
        requirementIds: [],
      });
    }
  }

  /* --- not a sensible choice for this kind of project --- */
  for (const component of active) {
    if (!component.entry || input.projectTypes.length === 0) {
      continue;
    }

    const suits = input.projectTypes.some((type) => suitsProjectType(component.entry!, type));

    if (!suits) {
      push({
        kind: 'unsupported_project_type',
        level: 'BLOCKING',
        categories: [component.category],
        componentIds: [component.id],
        summary: `${component.technologyName} does not target this kind of project.`,
        impact: `It cannot deliver ${input.projectTypes.join(', ').toLowerCase().replaceAll('_', ' ')} work.`,
        suggestion: 'Choose something that targets this platform, or change the project type.',
        requirementIds: [],
      });
    }
  }

  /* --- contradicts a technology the requirements name --- */
  for (const mandate of input.constraints.mandates) {
    /*
     * A mandate with no requirement behind it is a preference, and a preference
     * cannot make anything blocking. This is the guard that keeps "the user
     * would rather have X" from being presented to a client as "your
     * requirements demand X".
     */
    if (mandate.requirementIds.length === 0) {
      continue;
    }

    const satisfied = active.some((component) => component.entry?.id === mandate.technologyId);

    if (satisfied) {
      continue;
    }

    const occupying = active.filter((component) => component.category === mandate.category);

    if (occupying.length > 0) {
      push({
        kind: 'mandate_contradiction',
        level: 'BLOCKING',
        categories: [mandate.category],
        componentIds: occupying.map((component) => component.id),
        summary: `Your requirements ask for ${mandate.technologyName}, and the stack has ${occupying.map((component) => component.technologyName).join(', ')} instead.`,
        impact:
          'The stack contradicts an approved requirement, so it cannot be signed off as it is.',
        suggestion:
          'Use the technology the requirements ask for, or change the requirement — not the record of it.',
        requirementIds: [...mandate.requirementIds],
      });
    }
  }

  /* --- a constraint the requirements state --- */
  for (const component of active) {
    if (!component.entry) {
      continue;
    }

    if (input.constraints.selfHostedOnly && !component.entry.selfHostable) {
      push({
        kind: 'self_hosting_violation',
        level: 'BLOCKING',
        categories: [component.category],
        componentIds: [component.id],
        summary: `${component.technologyName} cannot be self-hosted, and your requirements say everything must be.`,
        impact: 'The stack contradicts an approved requirement.',
        suggestion: 'Choose something that runs on infrastructure the client controls.',
        requirementIds: [...input.constraints.selfHostedEvidence],
      });
    }

    if (input.constraints.noRecurringSpend && impliesSpend(component.entry.costPosture)) {
      push({
        kind: 'budget_violation',
        level: 'HIGH',
        categories: [component.category],
        componentIds: [component.id],
        summary: `${component.technologyName} costs money to run, and your requirements ask for no ongoing spend.`,
        impact: component.entry.commercialUseNote || 'This will appear as a recurring cost.',
        suggestion: 'Choose a self-hosted alternative, or confirm the budget covers this.',
        requirementIds: [...input.constraints.noSpendEvidence],
      });
    }

    if (input.constraints.dataResidency && !component.entry.selfHostable) {
      push({
        kind: 'data_residency_concern',
        level: 'HIGH',
        categories: [component.category],
        componentIds: [component.id],
        summary: `${component.technologyName} processes data outside the client’s infrastructure.`,
        impact:
          'Your requirements include a data-residency or privacy constraint that this touches.',
        suggestion: 'Confirm the vendor’s terms cover it, or choose something self-hosted.',
        requirementIds: [...input.constraints.dataResidencyEvidence],
      });
    }
  }

  /* --- things worth saying about a technology on its own --- */
  for (const component of active) {
    if (!component.entry) {
      continue;
    }

    if (component.entry.maturity === 'deprecated') {
      push({
        kind: 'deprecated_technology',
        level: 'HIGH',
        categories: [component.category],
        componentIds: [component.id],
        summary: `${component.technologyName} is no longer maintained.`,
        impact: 'Security fixes will not arrive, and hiring for it gets harder every year.',
        suggestion: 'Choose something maintained unless the client requires this one.',
        requirementIds: [],
      });
    }

    if (
      component.entry.operationalComplexity === 'high' &&
      component.entry.infrastructureBurden === 'high'
    ) {
      push({
        kind: 'operational_burden',
        level: 'MEDIUM',
        categories: [component.category],
        componentIds: [component.id],
        summary: `${component.technologyName} is heavy to run.`,
        impact:
          'Someone operates this for the life of the project. It belongs in the estimate and in the client’s expectations.',
        suggestion: 'Keep it if a requirement needs it. Drop it if none does.',
        requirementIds: [],
      });
    }

    if (RESTRICTIVE_LICENCES.some((licence) => component.entry?.licence.includes(licence))) {
      push({
        kind: 'licence_concern',
        level: 'LOW',
        categories: [component.category],
        componentIds: [component.id],
        summary: `${component.technologyName} is under ${component.entry.licence}.`,
        impact:
          component.entry.commercialUseNote || 'This licence carries obligations worth reading.',
        suggestion: 'Check it against how the client intends to distribute the result.',
        requirementIds: [],
      });
    }
  }

  /* --- a required slot with nothing in it --- */
  for (const category of input.requiredCategories) {
    if (!byCategory.has(category)) {
      push({
        kind: 'missing_required_category',
        level: 'MEDIUM',
        categories: [category],
        componentIds: [],
        summary: `Nothing has been chosen for ${categoryWord(category)}.`,
        impact: 'This project cannot be delivered without deciding it.',
        suggestion: 'Choose one, or let the AI suggest one.',
        requirementIds: [],
      });
    }
  }

  /* --- something nothing asked for --- */
  for (const [category, held] of byCategory) {
    if (
      JUSTIFIABLE.includes(category) &&
      !input.justifiedCategories.includes(category) &&
      held.length > 0
    ) {
      push({
        kind: 'unjustified_category',
        level: 'MEDIUM',
        categories: [category],
        componentIds: held.map((component) => component.id),
        summary: `Nothing in your requirements asks for ${categoryWord(category)}.`,
        impact:
          'It adds infrastructure to run and to pay for, and the estimate will include the work of running it.',
        suggestion: 'Keep it if you know why. Otherwise it is a component nobody needs.',
        requirementIds: [],
      });
    }
  }

  return findings;
}

/**
 * The categories worth questioning when nothing justifies them.
 *
 * Deliberately the same list as `JUSTIFICATION_REQUIRED_CATEGORIES`, restated
 * here as a local constant so this file has no import cycle with the module that
 * defines applicability.
 */
const JUSTIFIABLE: readonly TechnologyCategory[] = [
  'cache',
  'search',
  'vector_storage',
  'message_queue',
  'api_gateway',
  'realtime',
  'containerization',
  'data_processing',
];

/** Licences whose obligations a delivery team should see before committing. */
const RESTRICTIVE_LICENCES: readonly string[] = ['AGPL', 'SSPL', 'GPL', 'BSL', 'Elastic'];

/** The highest level present. `NONE` when the stack is clean. */
export function highestRisk(findings: readonly CompatibilityFinding[]): RiskLevel {
  return findings.reduce<RiskLevel>(
    (highest, finding) => (RISK_RANK[finding.level] > RISK_RANK[highest] ? finding.level : highest),
    'NONE',
  );
}

export function blockingFindings(
  findings: readonly CompatibilityFinding[],
): readonly CompatibilityFinding[] {
  return findings.filter((finding) => isBlocking(finding.level));
}

export function acknowledgeableFindings(
  findings: readonly CompatibilityFinding[],
): readonly CompatibilityFinding[] {
  return findings.filter((finding) => needsAcknowledgement(finding.level));
}

/** The user-facing word for a category. Lowercase, for mid-sentence use. */
function categoryWord(category: TechnologyCategory): string {
  return category.replaceAll('_', ' ');
}
