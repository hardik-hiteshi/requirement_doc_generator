import { describe, expect, it } from 'vitest';

import {
  AUTHORITY_RANK,
  STACK_AUTHORITY_LEVELS,
  STACK_COMPONENT_STATUSES,
  aiMayOccupy,
  aiMayReplace,
  authorityOf,
  canOverride,
  canTransitionComponent,
  isDecided,
  isMandated,
  modeNeedsInference,
} from './stack-authority.contract';
import {
  planCategories,
  projectTypeIsActionable,
  requiredCategories,
} from './project-type-categories';
import { allowsMultiple, requiresJustification } from './technology-category.contract';

/**
 * The rule the whole phase exists to enforce: a person's decision wins.
 *
 * These are the tests that would fail first if the precedence were ever
 * loosened — and loosening it is easy to do by accident, because "the model
 * knows better" is a plausible-sounding change to make in a hurry.
 */
describe('authority precedence', () => {
  it('ranks the levels in the order the specification states', () => {
    expect(STACK_AUTHORITY_LEVELS).toEqual([
      'UNDEFINED',
      'AI_RECOMMENDATION',
      'USER_SELECTED',
      'USER_APPROVED',
      'LOCKED_USER_SELECTION',
    ]);

    expect(AUTHORITY_RANK.LOCKED_USER_SELECTION).toBeGreaterThan(AUTHORITY_RANK.USER_APPROVED);
    expect(AUTHORITY_RANK.USER_APPROVED).toBeGreaterThan(AUTHORITY_RANK.USER_SELECTED);
    expect(AUTHORITY_RANK.USER_SELECTED).toBeGreaterThan(AUTHORITY_RANK.AI_RECOMMENDATION);
    expect(AUTHORITY_RANK.AI_RECOMMENDATION).toBeGreaterThan(AUTHORITY_RANK.UNDEFINED);
  });

  it('lets a higher authority take a slot from a lower one', () => {
    expect(canOverride('USER_SELECTED', 'AI_RECOMMENDATION')).toBe(true);
    expect(canOverride('LOCKED_USER_SELECTION', 'USER_APPROVED')).toBe(true);
    expect(canOverride('AI_RECOMMENDATION', 'UNDEFINED')).toBe(true);
  });

  it('refuses a lower authority taking a slot from a higher one', () => {
    expect(canOverride('AI_RECOMMENDATION', 'USER_SELECTED')).toBe(false);
    expect(canOverride('AI_RECOMMENDATION', 'USER_APPROVED')).toBe(false);
    expect(canOverride('AI_RECOMMENDATION', 'LOCKED_USER_SELECTION')).toBe(false);
    expect(canOverride('USER_SELECTED', 'USER_APPROVED')).toBe(false);
  });

  /*
   * Equal authority does not override. Two reasons: re-running recommendation
   * must be idempotent rather than a random walk, and one suggestion silently
   * replacing another is a change the user never saw happen.
   */
  it('refuses an equal authority overriding, so re-running settles rather than churns', () => {
    for (const level of STACK_AUTHORITY_LEVELS) {
      expect(canOverride(level, level)).toBe(false);
    }
  });

  it('lets the AI write only into an empty or previously-suggested slot', () => {
    expect(aiMayOccupy('UNDEFINED')).toBe(true);
    expect(aiMayOccupy('AI_RECOMMENDATION')).toBe(true);
    expect(aiMayOccupy('USER_SELECTED')).toBe(false);
    expect(aiMayOccupy('USER_APPROVED')).toBe(false);
    expect(aiMayOccupy('LOCKED_USER_SELECTION')).toBe(false);
  });

  /* The React + Laravel + MySQL case from the specification, stated directly. */
  it('keeps an explicitly selected technology whatever the AI would prefer', () => {
    for (const held of ['USER_SELECTED', 'USER_APPROVED', 'LOCKED_USER_SELECTION'] as const) {
      expect(canOverride('AI_RECOMMENDATION', held)).toBe(false);
      expect(aiMayOccupy(held)).toBe(false);
    }
  });
});

describe('component status and the authority it carries', () => {
  it('maps every status to an authority', () => {
    for (const status of STACK_COMPONENT_STATUSES) {
      expect(STACK_AUTHORITY_LEVELS).toContain(authorityOf(status));
    }
  });

  /* A turned-down suggestion decides nothing; it is kept as a record. */
  it('gives a rejected or superseded component no authority at all', () => {
    expect(authorityOf('REJECTED')).toBe('UNDEFINED');
    expect(authorityOf('SUPERSEDED')).toBe('UNDEFINED');
  });

  it('stops the AI touching anything a person decided', () => {
    expect(aiMayReplace('NOT_DEFINED')).toBe(true);
    expect(aiMayReplace('AI_RECOMMENDED')).toBe(true);
    expect(aiMayReplace('USER_SELECTED')).toBe(false);
    expect(aiMayReplace('USER_APPROVED')).toBe(false);
    expect(aiMayReplace('LOCKED')).toBe(false);
  });

  it('lets a rejected slot be filled again, since the user emptied it', () => {
    expect(aiMayReplace('REJECTED')).toBe(true);
  });

  it('counts only a real decision as decided', () => {
    expect(isDecided('USER_SELECTED')).toBe(true);
    expect(isDecided('USER_APPROVED')).toBe(true);
    expect(isDecided('LOCKED')).toBe(true);
    expect(isDecided('AI_RECOMMENDED')).toBe(false);
    expect(isDecided('NOT_DEFINED')).toBe(false);
    expect(isDecided('REJECTED')).toBe(false);
  });
});

describe('status transitions', () => {
  it('allows the ordinary path from suggestion to locked', () => {
    expect(canTransitionComponent('NOT_DEFINED', 'AI_RECOMMENDED')).toBe(true);
    expect(canTransitionComponent('AI_RECOMMENDED', 'USER_APPROVED')).toBe(true);
    expect(canTransitionComponent('USER_APPROVED', 'LOCKED')).toBe(true);
  });

  /* The single most important transition rule in the phase. */
  it('lets nothing out of LOCKED except the explicit unlock', () => {
    for (const status of STACK_COMPONENT_STATUSES) {
      const allowed = canTransitionComponent('LOCKED', status);

      expect(allowed, `LOCKED -> ${status}`).toBe(status === 'USER_APPROVED');
    }
  });

  it('refuses to reach LOCKED without a user approval first', () => {
    expect(canTransitionComponent('AI_RECOMMENDED', 'LOCKED')).toBe(false);
    expect(canTransitionComponent('NOT_DEFINED', 'LOCKED')).toBe(false);
    expect(canTransitionComponent('USER_SELECTED', 'LOCKED')).toBe(false);
  });

  it('makes a superseded component terminal', () => {
    for (const status of STACK_COMPONENT_STATUSES) {
      expect(canTransitionComponent('SUPERSEDED', status)).toBe(false);
    }
  });
});

describe('where a selection came from', () => {
  it('separates something the client requires from something the team prefers', () => {
    expect(isMandated('CLIENT_REQUIREMENT')).toBe(true);
    expect(isMandated('EXISTING_INFRASTRUCTURE')).toBe(true);
    expect(isMandated('USER')).toBe(false);
  });
});

describe('selection modes', () => {
  /* The MVP requirement: the stack step must work with no model at all. */
  it('needs no inference to choose everything by hand', () => {
    expect(modeNeedsInference('USER_SELECTS_ALL')).toBe(false);
    expect(modeNeedsInference('AI_RECOMMENDS_ALL')).toBe(true);
    expect(modeNeedsInference('HYBRID')).toBe(true);
  });
});

describe('which categories a project has', () => {
  it('requires a frontend for a website and no database', () => {
    const plan = planCategories(['WEBSITE']);
    const required = requiredCategories(plan);

    expect(required).toContain('web_frontend');
    expect(required).not.toContain('database');
    expect(required).not.toContain('backend');
  });

  /* An API service has no browser, and offering one invents a deliverable. */
  it('gives an API-only project no frontend at all', () => {
    const plan = planCategories(['BACKEND_API']);
    const frontend = plan.find((entry) => entry.category === 'web_frontend');

    expect(frontend?.applicability).toBe('not_applicable');
    expect(requiredCategories(plan)).toEqual(expect.arrayContaining(['backend', 'database']));
  });

  it('gives an Android-only project no iOS category', () => {
    const plan = planCategories(['ANDROID_APPLICATION']);

    expect(plan.find((entry) => entry.category === 'native_android')?.applicability).toBe(
      'required',
    );
    expect(plan.find((entry) => entry.category === 'native_ios')?.applicability).toBe(
      'not_applicable',
    );
  });

  it('gives an iOS-only project no Android category', () => {
    const plan = planCategories(['IOS_APPLICATION']);

    expect(plan.find((entry) => entry.category === 'native_ios')?.applicability).toBe('required');
    expect(plan.find((entry) => entry.category === 'native_android')?.applicability).toBe(
      'not_applicable',
    );
  });

  it('merges several project types, with the strongest applicability winning', () => {
    const plan = planCategories(['SAAS_PLATFORM', 'CROSS_PLATFORM_MOBILE']);
    const required = requiredCategories(plan);

    expect(required).toContain('web_frontend');
    expect(required).toContain('mobile_framework');
    expect(required).toContain('database');
  });

  /*
   * The rule that keeps a stack from growing infrastructure nobody asked for.
   * No project type, however large, can promote these.
   */
  it('never lets a project type promote a justification-required category', () => {
    for (const types of [
      ['SAAS_PLATFORM'],
      ['AI_ML_SOLUTION'],
      ['MULTI_PLATFORM_PRODUCT'],
      ['ECOMMERCE_PLATFORM'],
    ] as const) {
      const plan = planCategories([...types]);

      for (const entry of plan) {
        if (requiresJustification(entry.category)) {
          expect(entry.applicability, `${types[0]} / ${entry.category}`).toBe('conditional');
        }
      }
    }
  });

  it('does not make an AI project need a vector database', () => {
    const plan = planCategories(['AI_ML_SOLUTION']);
    const vectors = plan.find((entry) => entry.category === 'vector_storage');

    expect(vectors?.applicability).toBe('conditional');
    expect(requiredCategories(plan)).not.toContain('vector_storage');
    expect(requiredCategories(plan)).not.toContain('ai_runtime');
  });

  it('explains a conditional category in terms of the requirements, not project size', () => {
    const plan = planCategories(['SAAS_PLATFORM']);
    const cache = plan.find((entry) => entry.category === 'cache');

    expect(cache?.reason).toMatch(/approved requirements/i);
    expect(cache?.reason).toMatch(/not added on the basis of project size/i);
  });

  it('requires nothing at all for an enhancement, which inherits its stack', () => {
    expect(requiredCategories(planCategories(['APPLICATION_ENHANCEMENT']))).toEqual([]);
  });

  it('refuses to plan against a project type nobody confirmed', () => {
    expect(projectTypeIsActionable([])).toBe(false);
    expect(projectTypeIsActionable(['OTHER'])).toBe(false);
    expect(projectTypeIsActionable(['WEB_APPLICATION', 'OTHER'])).toBe(false);
    expect(projectTypeIsActionable(['WEB_APPLICATION'])).toBe(true);
  });

  it('requires nothing for an unconfirmed type rather than guessing', () => {
    expect(requiredCategories(planCategories(['OTHER']))).toEqual([]);
  });
});

describe('how many technologies a category holds', () => {
  it('allows only one of the things a project has one of', () => {
    expect(allowsMultiple('database')).toBe(false);
    expect(allowsMultiple('backend')).toBe(false);
    expect(allowsMultiple('web_frontend')).toBe(false);
  });

  it('allows several where a project genuinely has several', () => {
    expect(allowsMultiple('integrations')).toBe(true);
    expect(allowsMultiple('testing')).toBe(true);
    expect(allowsMultiple('payment')).toBe(true);
  });
});
