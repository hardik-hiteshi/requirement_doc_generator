import {
  EMPTY_CONSTRAINTS,
  TECHNOLOGY_CATALOG,
  matchesName,
  type StackConstraints,
  type TechnologyMandate,
} from '@wdrg/contracts';

/**
 * What the approved requirements say about how this must be built.
 *
 * Four constraints, read out of requirement text by keyword. Two properties
 * matter more than the matching itself.
 *
 * **Every constraint carries the requirement ids behind it.** A constraint with
 * no evidence cannot make anything blocking — it is somebody's preference, and a
 * preference presented to a client as their own requirement is a
 * misrepresentation. The compatibility rules check for the ids before they
 * escalate anything.
 *
 * **It fails towards silence.** A keyword scan over free text is a blunt
 * instrument, so it is tuned to miss rather than to over-claim. Missing a
 * self-hosting requirement means a warning the user has to notice themselves;
 * inventing one means a blocking finding against a technology the client
 * actually asked for.
 *
 * Only approved, non-rejected requirements are read — a rejected requirement is
 * one somebody decided against, and treating it as a constraint would resurrect
 * a decision that was already made.
 */

export interface ConstraintSource {
  readonly itemId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
}

/** Requirement statuses that no longer state anything about the project. */
const IGNORED_STATUSES: readonly string[] = ['rejected', 'superseded', 'duplicate'];

const SELF_HOSTED_PHRASES: readonly string[] = [
  'self-host',
  'self host',
  'on-premise',
  'on premise',
  'on-prem',
  'must remain on the client',
  'inside our network',
  'no cloud',
  'not use any cloud',
  'own infrastructure',
  'own servers',
];

const NO_SPEND_PHRASES: readonly string[] = [
  'no licence fee',
  'no license fee',
  'no subscription',
  'no recurring cost',
  'no ongoing cost',
  'open-source only',
  'open source only',
  'without paid',
  'no paid service',
  'zero cost',
];

const RESIDENCY_PHRASES: readonly string[] = [
  'data residency',
  'must not leave',
  'remain within the eu',
  'remain in the eu',
  'stay within the country',
  'gdpr',
  'personal data must be stored',
  'data sovereignty',
];

/** Words that mean a requirement is naming a technology, not mentioning one. */
const MANDATE_PHRASES: readonly string[] = [
  'must use',
  'must be built with',
  'must be built on',
  'must run on',
  'is required to use',
  'the client requires',
  'mandates',
  'standardised on',
  'standardized on',
];

export function deriveConstraints(sources: readonly ConstraintSource[]): StackConstraints {
  const live = sources.filter((source) => !IGNORED_STATUSES.includes(source.status));

  if (live.length === 0) {
    return EMPTY_CONSTRAINTS;
  }

  const selfHostedEvidence: string[] = [];
  const noSpendEvidence: string[] = [];
  const dataResidencyEvidence: string[] = [];
  const mandates = new Map<string, TechnologyMandate>();

  for (const source of live) {
    const text = `${source.title} ${source.description}`.toLowerCase();

    if (SELF_HOSTED_PHRASES.some((phrase) => text.includes(phrase))) {
      selfHostedEvidence.push(source.itemId);
    }

    if (NO_SPEND_PHRASES.some((phrase) => text.includes(phrase))) {
      noSpendEvidence.push(source.itemId);
    }

    if (RESIDENCY_PHRASES.some((phrase) => text.includes(phrase))) {
      dataResidencyEvidence.push(source.itemId);
    }

    /*
     * A mandate needs both halves: a phrase that means "this is required", and
     * a technology name. "We use PostgreSQL today" is context; "the system must
     * use PostgreSQL" is a constraint, and only the second may make a competing
     * choice blocking.
     */
    if (!MANDATE_PHRASES.some((phrase) => text.includes(phrase))) {
      continue;
    }

    for (const entry of TECHNOLOGY_CATALOG) {
      const named =
        matchesName(entry, entry.name) &&
        [entry.name, ...entry.aliases].some((label) => containsWord(text, label.toLowerCase()));

      if (!named) {
        continue;
      }

      const held = mandates.get(entry.id);

      mandates.set(entry.id, {
        technologyId: entry.id,
        technologyName: entry.name,
        category: entry.category,
        requirementIds: [...(held?.requirementIds ?? []), source.itemId],
      });
    }
  }

  return {
    selfHostedOnly: selfHostedEvidence.length > 0,
    selfHostedEvidence,
    noRecurringSpend: noSpendEvidence.length > 0,
    noSpendEvidence,
    dataResidency: dataResidencyEvidence.length > 0,
    dataResidencyEvidence,
    mandates: [...mandates.values()],
  };
}

/**
 * Whole-word containment.
 *
 * `includes` alone would match "go" inside "category" and "algorithm", turning
 * an unrelated sentence into a mandate for the Go language. Short technology
 * names are exactly where a substring match goes wrong, and exactly where a
 * false mandate does the most damage.
 */
function containsWord(haystack: string, needle: string): boolean {
  if (!needle) {
    return false;
  }

  let from = 0;

  for (;;) {
    const at = haystack.indexOf(needle, from);

    if (at === -1) {
      return false;
    }

    const before = at === 0 ? ' ' : haystack[at - 1]!;
    const after = at + needle.length >= haystack.length ? ' ' : haystack[at + needle.length]!;

    if (!isWordCharacter(before) && !isWordCharacter(after)) {
      return true;
    }

    from = at + 1;
  }
}

function isWordCharacter(character: string): boolean {
  return /[a-z0-9]/.test(character);
}
