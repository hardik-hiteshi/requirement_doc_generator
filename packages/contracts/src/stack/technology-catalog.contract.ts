import { z } from 'zod';

import { technologyCategorySchema, type TechnologyCategory } from './technology-category.contract';
import { PROJECT_TYPES, type ProjectType } from '../project/project-type.contract';

/**
 * The technologies this application knows about, as reviewed facts.
 *
 * A recommendation is only as good as what it is allowed to say. Letting a
 * small model free-associate technology names produces confident nonsense —
 * plausible framework names that do not exist, licences it has misremembered,
 * "the latest version" invented on the spot. All of it lands in a document a
 * client is asked to sign.
 *
 * So the model picks from here. It returns a `technologyId`; anything not in the
 * catalogue is rejected by the structured-output validator and the run is
 * repaired or failed. The facts attached to the recommendation — licence, cost
 * posture, whether it can be self-hosted — come from this file, not from the
 * model, because those are the facts a client makes commercial decisions on.
 *
 * ## What is deliberately not here
 *
 * **Prices.** There is no maintained source for what AWS or Auth0 costs today,
 * and a number recalled by a language model in a signed estimate is a
 * liability. `costPosture` says *how a technology charges* — free when
 * self-hosted, usage-based, commercial licence — which is stable, checkable, and
 * the thing that actually changes a delivery plan.
 *
 * **Version numbers, mostly.** See `version.contract.ts`. A catalogue entry may
 * carry a reviewed recommended version; most do not, and "latest" is never
 * asserted.
 *
 * ## The user is not limited to it
 *
 * A custom technology the user types is authoritative and needs no catalogue
 * entry. It simply carries fewer known facts, and the application says so
 * rather than guessing them.
 */

export const CATALOG_VERSION = '2026.08.1';

/** How a technology charges. Not a price — a posture. */
export const COST_POSTURES = [
  /** Free to run on your own infrastructure. Costs are hosting and time. */
  'FREE_SELF_HOSTED',
  /** A free tier exists that a real project might live inside. */
  'FREE_TIER_AVAILABLE',
  /** A licence must be bought. */
  'COMMERCIAL',
  /** Billed by consumption: requests, storage, seats, tokens. */
  'USAGE_BASED',
  /** Open-source core with a paid hosted or enterprise edition. */
  'MIXED',
  /** Not established. Shown as unknown rather than guessed. */
  'UNKNOWN',
] as const;

export type CostPosture = (typeof COST_POSTURES)[number];
export const costPostureSchema = z.enum(COST_POSTURES);

export const COST_POSTURE_LABELS: Readonly<Record<CostPosture, string>> = {
  FREE_SELF_HOSTED: 'Free, self-hosted',
  FREE_TIER_AVAILABLE: 'Free tier available',
  COMMERCIAL: 'Commercial licence',
  USAGE_BASED: 'Pay per use',
  MIXED: 'Free core, paid hosted edition',
  UNKNOWN: 'Not established',
};

export const COST_POSTURE_DESCRIPTIONS: Readonly<Record<CostPosture, string>> = {
  FREE_SELF_HOSTED:
    'No licence fee. You pay for the infrastructure it runs on and the time to run it.',
  FREE_TIER_AVAILABLE: 'Has a free tier. Whether this project fits inside it depends on usage.',
  COMMERCIAL: 'Requires a purchased licence. Budget for it explicitly.',
  USAGE_BASED: 'Billed by consumption, so the cost follows the traffic rather than the contract.',
  MIXED: 'The open-source edition is free to self-host; the hosted or enterprise edition is not.',
  UNKNOWN: 'This application does not hold a reviewed cost position for this technology.',
};

/** Cost postures that mean money leaves the client's account. */
export const PAID_COST_POSTURES: readonly CostPosture[] = ['COMMERCIAL', 'USAGE_BASED'];

export function impliesSpend(posture: CostPosture): boolean {
  return PAID_COST_POSTURES.includes(posture);
}

/** What kind of thing it is, since "technology" covers very different objects. */
export const TECHNOLOGY_TYPES = [
  'language',
  'framework',
  'library',
  'runtime',
  'database',
  'service',
  'platform',
  'tool',
  'protocol',
  'model',
] as const;

export type TechnologyType = (typeof TECHNOLOGY_TYPES)[number];
export const technologyTypeSchema = z.enum(TECHNOLOGY_TYPES);

/** How settled it is. Bearing on delivery risk, not on quality. */
export const MATURITY_LEVELS = [
  /** Widely deployed, long-lived, easy to hire for. */
  'established',
  /** Production-ready and growing, with a smaller hiring pool. */
  'growing',
  /** Real but young. Expect churn. */
  'emerging',
  /** Still maintained, but the ecosystem has moved on. */
  'legacy',
  /** No longer maintained. */
  'deprecated',
] as const;

export type MaturityLevel = (typeof MATURITY_LEVELS)[number];
export const maturityLevelSchema = z.enum(MATURITY_LEVELS);

export const MATURITY_LABELS: Readonly<Record<MaturityLevel, string>> = {
  established: 'Established',
  growing: 'Growing',
  emerging: 'Emerging',
  legacy: 'Legacy',
  deprecated: 'No longer maintained',
};

/** Coarse three-point scales. Comparative, never a number of days. */
export const BURDEN_LEVELS = ['low', 'medium', 'high'] as const;
export type BurdenLevel = (typeof BURDEN_LEVELS)[number];
export const burdenLevelSchema = z.enum(BURDEN_LEVELS);

/**
 * One technology, as reviewed.
 *
 * `incompatibleWith` is the field that carries weight: it is the only source of
 * a hard incompatibility, and the model cannot add to it. If two technologies
 * genuinely cannot be combined, a person establishes that here and every
 * project gets the same answer.
 */
export const catalogEntrySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Catalogue ids are lowercase, hyphenated'),
    name: z.string().min(1).max(80),
    category: technologyCategorySchema,
    /** Other categories this can legitimately fill. Node fills backend and runtime. */
    secondaryCategories: z.array(technologyCategorySchema).max(6),
    /** Names a user might type meaning this. Matched case-insensitively. */
    aliases: z.array(z.string().min(1).max(60)).max(12),
    type: technologyTypeSchema,
    openSource: z.boolean(),
    /** SPDX identifier where one applies, or a short name. Empty when proprietary. */
    licence: z.string().max(60),
    /** Anything a delivery team needs to know before committing. */
    commercialUseNote: z.string().max(300),
    selfHostable: z.boolean(),
    managedServiceAvailable: z.boolean(),
    maturity: maturityLevelSchema,
    /** Project types this is a sensible choice for. Empty means any. */
    supportedProjectTypes: z.array(z.enum(PROJECT_TYPES)).max(PROJECT_TYPES.length),
    /** Catalogue ids that cannot be combined with this one, with a reason. */
    incompatibleWith: z
      .array(
        z
          .object({
            technologyId: z.string().min(1).max(64),
            reason: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(20),
    strengths: z.array(z.string().min(1).max(200)).max(8),
    limitations: z.array(z.string().min(1).max(200)).max(8),
    operationalComplexity: burdenLevelSchema,
    infrastructureBurden: burdenLevelSchema,
    learningBurden: burdenLevelSchema,
    costPosture: costPostureSchema,
    /**
     * A version only where one has actually been reviewed.
     *
     * Absent on almost everything, on purpose. See `version.contract.ts`.
     */
    recommendedVersion: z.string().max(30).optional(),
    catalogVersion: z.string().min(1).max(20),
    lastReviewed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/**
 * Whether a catalogue entry can fill a category.
 *
 * Secondary categories exist because the mapping is genuinely many-to-many —
 * PostgreSQL is a database and, with pgvector, vector storage — and pretending
 * otherwise forces duplicate entries that then drift apart.
 */
export function fillsCategory(entry: CatalogEntry, category: TechnologyCategory): boolean {
  return entry.category === category || entry.secondaryCategories.includes(category);
}

/**
 * Whether this technology suits a project type.
 *
 * An empty `supportedProjectTypes` means "no opinion" rather than "none" —
 * PostgreSQL does not care what is in front of it, and listing all nineteen
 * project types on every general-purpose entry would be noise that goes stale.
 */
export function suitsProjectType(entry: CatalogEntry, type: ProjectType): boolean {
  return entry.supportedProjectTypes.length === 0 || entry.supportedProjectTypes.includes(type);
}

/** Case-insensitive match against the canonical name and every alias. */
export function matchesName(entry: CatalogEntry, name: string): boolean {
  const needle = name.trim().toLowerCase();

  return (
    entry.name.toLowerCase() === needle ||
    entry.aliases.some((alias) => alias.toLowerCase() === needle)
  );
}
