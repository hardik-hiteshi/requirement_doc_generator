import { describe, expect, it } from 'vitest';

import {
  ACKNOWLEDGEMENT_THRESHOLD,
  EMPTY_CONSTRAINTS,
  acknowledgeableFindings,
  blockingFindings,
  evaluateCompatibility,
  highestRisk,
  isBlocking,
  needsAcknowledgement,
  type ComponentFacts,
  type CompatibilityInput,
  type StackConstraints,
} from './compatibility.contract';
import { calculateStackBlockers } from './stack-blockers';
import {
  calculateStackEvidence,
  explainStackEvidence,
  stackEvidenceBandFor,
  type StackEvidenceFacts,
} from './stack-evidence';
import { findTechnology } from './technology-catalog.data';
import type { TechnologyCategory } from './technology-category.contract';

/**
 * Compatibility is where a model would be most tempting and most dangerous.
 *
 * *"pgvector needs PostgreSQL"* is a fact; *"pgvector needs PostgreSQL"* said by
 * a small model is a guess that happens to be right this time. These tests pin
 * the rules to the catalogue, so the same stack always produces the same
 * findings and a reviewer can trace each one to the entry that caused it.
 */

function component(
  id: string,
  category: TechnologyCategory,
  technologyId: string | undefined,
  name?: string,
): ComponentFacts {
  const entry = technologyId ? findTechnology(technologyId) : undefined;

  return {
    id,
    category,
    technologyName: name ?? entry?.name ?? technologyId ?? 'Something',
    entry,
    active: true,
  };
}

function input(overrides: Partial<CompatibilityInput> = {}): CompatibilityInput {
  return {
    projectTypes: ['WEB_APPLICATION'],
    components: [],
    constraints: EMPTY_CONSTRAINTS,
    requiredCategories: [],
    justifiedCategories: [],
    ...overrides,
  };
}

describe('risk levels', () => {
  it('reserves BLOCKING for things that cannot proceed', () => {
    expect(isBlocking('BLOCKING')).toBe(true);
    expect(isBlocking('HIGH')).toBe(false);
  });

  /*
   * The distinction the specification insists on: HIGH is acknowledgeable, so
   * the user keeps their choice. BLOCKING is not, because it contradicts an
   * approved requirement or cannot be built.
   */
  it('lets a HIGH warning be acknowledged and a BLOCKING one not', () => {
    expect(ACKNOWLEDGEMENT_THRESHOLD).toBe('HIGH');
    expect(needsAcknowledgement('HIGH')).toBe(true);
    expect(needsAcknowledgement('BLOCKING')).toBe(false);
    expect(needsAcknowledgement('MEDIUM')).toBe(false);
    expect(needsAcknowledgement('LOW')).toBe(false);
  });

  it('reports the worst level present', () => {
    expect(highestRisk([])).toBe('NONE');
  });
});

describe('the deterministic rules', () => {
  it('finds nothing wrong with a coherent stack', () => {
    const findings = evaluateCompatibility(
      input({
        components: [
          component('c1', 'web_frontend', 'react'),
          component('c2', 'backend', 'nestjs'),
          component('c3', 'database', 'postgresql'),
        ],
        requiredCategories: ['web_frontend', 'backend', 'database'],
      }),
    );

    expect(blockingFindings(findings)).toEqual([]);
  });

  it('blocks a technology put in a category it cannot fill', () => {
    const findings = evaluateCompatibility(
      input({ components: [component('c1', 'database', 'react')] }),
    );
    const mismatch = findings.find((finding) => finding.kind === 'category_mismatch');

    expect(mismatch?.level).toBe('BLOCKING');
    expect(mismatch?.summary).toContain('React');
  });

  it('blocks two technologies the catalogue says cannot be combined', () => {
    const findings = evaluateCompatibility(
      input({
        components: [
          component('c1', 'database', 'mysql'),
          component('c2', 'vector_storage', 'pgvector'),
        ],
      }),
    );
    const clash = findings.find((finding) => finding.kind === 'mutual_incompatibility');

    expect(clash?.level).toBe('BLOCKING');
    expect(clash?.impact).toContain('PostgreSQL extension');
  });

  /* Declared once on pgvector; the rule has to read it from either side. */
  it('reads an incompatibility whichever entry declares it', () => {
    const forwards = evaluateCompatibility(
      input({
        components: [
          component('a1', 'vector_storage', 'pgvector'),
          component('b2', 'database', 'mongodb'),
        ],
      }),
    );
    const backwards = evaluateCompatibility(
      input({
        components: [
          component('a1', 'database', 'mongodb'),
          component('b2', 'vector_storage', 'pgvector'),
        ],
      }),
    );

    expect(forwards.some((finding) => finding.kind === 'mutual_incompatibility')).toBe(true);
    expect(backwards.some((finding) => finding.kind === 'mutual_incompatibility')).toBe(true);
  });

  it('blocks two things doing one job', () => {
    const findings = evaluateCompatibility(
      input({
        components: [
          component('c1', 'database', 'postgresql'),
          component('c2', 'database', 'mysql'),
        ],
      }),
    );
    const duplicate = findings.find((finding) => finding.kind === 'duplicate_responsibility');

    expect(duplicate?.level).toBe('BLOCKING');
  });

  it('allows several technologies where the category holds several', () => {
    const findings = evaluateCompatibility(
      input({
        components: [
          component('c1', 'integrations', 'rest-api'),
          component('c2', 'integrations', 'sftp-exchange'),
        ],
      }),
    );

    expect(findings.some((finding) => finding.kind === 'duplicate_responsibility')).toBe(false);
  });

  it('blocks an iOS framework on an Android-only project', () => {
    const findings = evaluateCompatibility(
      input({
        projectTypes: ['ANDROID_APPLICATION'],
        components: [component('c1', 'native_ios', 'swift-ios')],
      }),
    );
    const unsupported = findings.find((finding) => finding.kind === 'unsupported_project_type');

    expect(unsupported?.level).toBe('BLOCKING');
    expect(unsupported?.summary).toContain('Swift');
  });

  it('blocks a database that contradicts one the requirements name', () => {
    const constraints: StackConstraints = {
      ...EMPTY_CONSTRAINTS,
      mandates: [
        {
          technologyId: 'mysql',
          technologyName: 'MySQL',
          category: 'database',
          requirementIds: ['REQ-014'],
        },
      ],
    };
    const findings = evaluateCompatibility(
      input({ components: [component('c1', 'database', 'postgresql')], constraints }),
    );
    const contradiction = findings.find((finding) => finding.kind === 'mandate_contradiction');

    expect(contradiction?.level).toBe('BLOCKING');
    expect(contradiction?.requirementIds).toEqual(['REQ-014']);
  });

  it('says nothing when the mandated technology is the one chosen', () => {
    const constraints: StackConstraints = {
      ...EMPTY_CONSTRAINTS,
      mandates: [
        {
          technologyId: 'mysql',
          technologyName: 'MySQL',
          category: 'database',
          requirementIds: ['REQ-014'],
        },
      ],
    };
    const findings = evaluateCompatibility(
      input({ components: [component('c1', 'database', 'mysql')], constraints }),
    );

    expect(findings.some((finding) => finding.kind === 'mandate_contradiction')).toBe(false);
  });

  /*
   * The guard that keeps a preference from being presented to a client as their
   * own requirement. Without evidence, a mandate is somebody's opinion.
   */
  it('will not block on a mandate with no requirement behind it', () => {
    const constraints: StackConstraints = {
      ...EMPTY_CONSTRAINTS,
      mandates: [
        {
          technologyId: 'mysql',
          technologyName: 'MySQL',
          category: 'database',
          requirementIds: [],
        },
      ],
    };
    const findings = evaluateCompatibility(
      input({ components: [component('c1', 'database', 'postgresql')], constraints }),
    );

    expect(findings.some((finding) => finding.kind === 'mandate_contradiction')).toBe(false);
  });

  it('blocks a hosted service where the requirements demand self-hosting', () => {
    const constraints: StackConstraints = {
      ...EMPTY_CONSTRAINTS,
      selfHostedOnly: true,
      selfHostedEvidence: ['REQ-002'],
    };
    const findings = evaluateCompatibility(
      input({ components: [component('c1', 'object_storage', 's3')], constraints }),
    );
    const violation = findings.find((finding) => finding.kind === 'self_hosting_violation');

    expect(violation?.level).toBe('BLOCKING');
    expect(violation?.requirementIds).toEqual(['REQ-002']);
  });

  it('warns rather than blocks when a paid service meets a no-spend requirement', () => {
    const constraints: StackConstraints = {
      ...EMPTY_CONSTRAINTS,
      noRecurringSpend: true,
      noSpendEvidence: ['REQ-009'],
    };
    const findings = evaluateCompatibility(
      input({ components: [component('c1', 'authentication', 'auth0')], constraints }),
    );
    const budget = findings.find((finding) => finding.kind === 'budget_violation');

    expect(budget?.level).toBe('HIGH');
    expect(needsAcknowledgement(budget!.level)).toBe(true);
  });

  it('names a heavy technology as an operational cost rather than forbidding it', () => {
    const findings = evaluateCompatibility(
      input({
        components: [component('c1', 'containerization', 'kubernetes')],
        justifiedCategories: ['containerization'],
      }),
    );
    const burden = findings.find((finding) => finding.kind === 'operational_burden');

    expect(burden?.level).toBe('MEDIUM');
    expect(blockingFindings(findings)).toEqual([]);
  });

  it('flags a licence with obligations without stopping anything', () => {
    const findings = evaluateCompatibility(
      input({ components: [component('c1', 'object_storage', 'minio')] }),
    );
    const licence = findings.find((finding) => finding.kind === 'licence_concern');

    expect(licence?.level).toBe('LOW');
    expect(licence?.summary).toContain('AGPL');
  });

  it('names a required category with nothing in it', () => {
    const findings = evaluateCompatibility(
      input({
        components: [component('c1', 'backend', 'nestjs')],
        requiredCategories: ['database'],
      }),
    );

    expect(findings.some((finding) => finding.kind === 'missing_required_category')).toBe(true);
  });

  /* The Redis-because-it-is-big case, caught. */
  it('questions a cache nothing in the requirements asked for', () => {
    const findings = evaluateCompatibility(
      input({ components: [component('c1', 'cache', 'redis')] }),
    );
    const unjustified = findings.find((finding) => finding.kind === 'unjustified_category');

    expect(unjustified?.level).toBe('MEDIUM');
    expect(unjustified?.summary).toContain('cache');
  });

  it('says nothing about a cache a requirement justified', () => {
    const findings = evaluateCompatibility(
      input({
        components: [component('c1', 'cache', 'redis')],
        justifiedCategories: ['cache'],
      }),
    );

    expect(findings.some((finding) => finding.kind === 'unjustified_category')).toBe(false);
  });

  /*
   * A custom technology carries no reviewed facts, so no rule that reads them
   * may fire. Inventing facts about something a user typed is the worst
   * available failure — it looks authoritative and is pure guesswork.
   */
  it('asserts nothing about a technology the user typed', () => {
    const findings = evaluateCompatibility(
      input({
        components: [
          { ...component('c1', 'backend', undefined, 'Our in-house framework'), entry: undefined },
        ],
      }),
    );

    expect(findings.filter((finding) => finding.componentIds.includes('c1'))).toEqual([]);
  });

  it('ignores a rejected component entirely', () => {
    const findings = evaluateCompatibility(
      input({
        components: [
          { ...component('c1', 'database', 'postgresql'), active: false },
          component('c2', 'database', 'mysql'),
        ],
      }),
    );

    expect(findings.some((finding) => finding.kind === 'duplicate_responsibility')).toBe(false);
  });

  it('marks every finding it produces as deterministic', () => {
    const findings = evaluateCompatibility(
      input({ components: [component('c1', 'database', 'react')] }),
    );

    expect(findings.every((finding) => finding.deterministic)).toBe(true);
  });

  it('produces the same findings in the same order every time', () => {
    const stack = input({
      components: [
        component('c1', 'database', 'mysql'),
        component('c2', 'vector_storage', 'pgvector'),
        component('c3', 'cache', 'redis'),
      ],
    });

    expect(evaluateCompatibility(stack)).toEqual(evaluateCompatibility(stack));
  });
});

describe('approval blockers', () => {
  const base = {
    components: [],
    requiredCategories: [] as readonly TechnologyCategory[],
    findings: [],
    baselineApproved: true,
    baselineCurrent: true,
    projectTypeConfirmed: true,
  };

  it('stops everything when the baseline is not approved', () => {
    const blockers = calculateStackBlockers({ ...base, baselineApproved: false });

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.kind).toBe('baseline_not_approved');
  });

  it('stops everything when the project type is unconfirmed', () => {
    const blockers = calculateStackBlockers({ ...base, projectTypeConfirmed: false });

    expect(blockers[0]?.kind).toBe('project_type_unconfirmed');
  });

  it('refuses an empty stack', () => {
    expect(calculateStackBlockers(base)[0]?.kind).toBe('empty_stack');
  });

  it('refuses while a suggestion is still waiting for a decision', () => {
    const blockers = calculateStackBlockers({
      ...base,
      components: [
        {
          id: 'c1',
          category: 'database',
          technologyName: 'PostgreSQL',
          status: 'AI_RECOMMENDED',
          acknowledgedFindingIds: [],
        },
      ],
    });

    expect(blockers.some((blocker) => blocker.kind === 'undecided_recommendation')).toBe(true);
  });

  it('allows approval once every suggestion has been decided', () => {
    const blockers = calculateStackBlockers({
      ...base,
      requiredCategories: ['database'],
      components: [
        {
          id: 'c1',
          category: 'database',
          technologyName: 'PostgreSQL',
          status: 'USER_APPROVED',
          acknowledgedFindingIds: [],
        },
      ],
    });

    expect(blockers).toEqual([]);
  });

  it('every blocker says what to do about it', () => {
    const blockers = calculateStackBlockers({ ...base, baselineApproved: false });

    for (const blocker of blockers) {
      expect(blocker.action.length).toBeGreaterThan(10);
    }
  });
});

describe('evidence strength', () => {
  const facts = (overrides: Partial<StackEvidenceFacts> = {}): StackEvidenceFacts => ({
    evidenceKind: 'ARCHITECTURAL_DERIVATION',
    requirementIds: [],
    clarificationKeys: [],
    mandatedByRequirement: false,
    satisfiesStatedConstraint: false,
    userSelected: false,
    inCatalog: true,
    hasOpenConflict: false,
    missingInfrastructureContext: false,
    ...overrides,
  });

  it('is the sum of its contributions, exactly', () => {
    const result = calculateStackEvidence(
      facts({
        evidenceKind: 'CLIENT_REQUIREMENT',
        requirementIds: ['REQ-1', 'REQ-2'],
        mandatedByRequirement: true,
      }),
    );
    const sum = result.contributions.reduce((total, item) => total + item.weight, 0);

    expect(result.score).toBeCloseTo(Math.min(1, sum), 4);
  });

  it('scores a technology a requirement names higher than one nothing does', () => {
    const named = calculateStackEvidence(
      facts({
        evidenceKind: 'CLIENT_REQUIREMENT',
        requirementIds: ['REQ-1'],
        mandatedByRequirement: true,
      }),
    );
    const unnamed = calculateStackEvidence(facts());

    expect(named.score).toBeGreaterThan(unnamed.score);
  });

  it('subtracts for an unresolved compatibility problem', () => {
    const clean = calculateStackEvidence(facts({ userSelected: true }));
    const conflicted = calculateStackEvidence(facts({ userSelected: true, hasOpenConflict: true }));

    expect(conflicted.score).toBeLessThan(clean.score);
  });

  it('never goes below zero or above one', () => {
    const worst = calculateStackEvidence(
      facts({ inCatalog: false, hasOpenConflict: true, missingInfrastructureContext: true }),
    );
    const best = calculateStackEvidence(
      facts({
        evidenceKind: 'CLIENT_REQUIREMENT',
        requirementIds: ['a', 'b', 'c'],
        clarificationKeys: ['Q-1'],
        mandatedByRequirement: true,
        satisfiesStatedConstraint: true,
        userSelected: true,
      }),
    );

    expect(worst.score).toBe(0);
    expect(best.score).toBeLessThanOrEqual(1);
  });

  it('bands a score nothing supports as unsupported', () => {
    expect(stackEvidenceBandFor(0)).toBe('unsupported');
    expect(stackEvidenceBandFor(0.2)).toBe('weak');
    expect(stackEvidenceBandFor(0.4)).toBe('moderate');
    expect(stackEvidenceBandFor(0.9)).toBe('strong');
  });

  /* The Phase 4 rule, restated where it could most easily be broken. */
  it('has nowhere for a model confidence to enter', () => {
    const keys = Object.keys(facts());

    expect(keys).not.toContain('modelConfidence');
    expect(keys.some((key) => key.toLowerCase().includes('confidence'))).toBe(false);
  });

  it('explains itself from the same contributions it scored', () => {
    const result = calculateStackEvidence(facts({ userSelected: true, hasOpenConflict: true }));
    const explanation = explainStackEvidence(result);

    expect(explanation).toContain('you chose it');
    expect(explanation).toContain('against that');
  });

  it('says so plainly when nothing at all is known', () => {
    const result = calculateStackEvidence(facts({ inCatalog: false }));

    expect(result.contributions).toEqual([]);
    expect(explainStackEvidence(result)).toContain('Nothing was found');
  });
});

describe('finding helpers', () => {
  it('separates what blocks from what can be acknowledged', () => {
    const findings = evaluateCompatibility(
      input({
        components: [
          component('c1', 'database', 'react'),
          component('c2', 'authentication', 'auth0'),
        ],
        constraints: {
          ...EMPTY_CONSTRAINTS,
          noRecurringSpend: true,
          noSpendEvidence: ['REQ-009'],
        },
      }),
    );

    expect(blockingFindings(findings)).toHaveLength(1);
    expect(acknowledgeableFindings(findings)).toHaveLength(1);
    expect(highestRisk(findings)).toBe('BLOCKING');
  });
});
