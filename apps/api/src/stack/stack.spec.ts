import {
  TECHNOLOGY_CATALOG,
  planCategories,
  type CategoryApplicabilityEntry,
  type TechnologyCategory,
} from '@wdrg/contracts';

import { deriveConstraints, type ConstraintSource } from './constraints.service';
import { RecommendationService } from './recommendation.service';
import { stackRecommendationOutputSchema } from './recommendation-schema';
import { echoResponse } from '../analysis/providers/echo-scenario';
import { getPrompt } from '../analysis/prompts/prompt-registry';
import type { InferenceRequest } from '../analysis/providers/inference.types';
import type { StackComponentDocument } from './schemas/stack.schema';

/**
 * The Phase 5 logic that runs before anything reaches a database.
 *
 * Three things are pinned here, and each is a place where a plausible-looking
 * change would quietly break the phase's central promise:
 *
 * - **Constraints need evidence.** A constraint with no requirement behind it is
 *   a preference, and a preference must never be presented to a client as their
 *   own requirement.
 * - **The recommendation filter never offers a decided category.** This is the
 *   first of two guards on user authority; the second is at the write.
 * - **The model's output shape has nowhere to put an authority, a status or a
 *   version.** It cannot say a technology is locked, and it cannot claim a
 *   version number it has no way to know.
 */

function source(overrides: Partial<ConstraintSource> = {}): ConstraintSource {
  return {
    itemId: 'REQ-001',
    title: 'A requirement',
    description: 'Some text.',
    status: 'accepted',
    ...overrides,
  };
}

describe('reading constraints out of approved requirements', () => {
  it('finds a self-hosting requirement and keeps the requirement id', () => {
    const constraints = deriveConstraints([
      source({
        itemId: 'REQ-002',
        description: 'The system must be self-hosted on the client’s own servers.',
      }),
    ]);

    expect(constraints.selfHostedOnly).toBe(true);
    expect(constraints.selfHostedEvidence).toEqual(['REQ-002']);
  });

  it('finds a no-spend requirement', () => {
    const constraints = deriveConstraints([
      source({ itemId: 'REQ-009', description: 'Open-source only, with no subscription costs.' }),
    ]);

    expect(constraints.noRecurringSpend).toBe(true);
    expect(constraints.noSpendEvidence).toEqual(['REQ-009']);
  });

  it('finds a data-residency requirement', () => {
    const constraints = deriveConstraints([
      source({ description: 'Personal data must not leave the EU.' }),
    ]);

    expect(constraints.dataResidency).toBe(true);
  });

  /*
   * A rejected requirement is one somebody decided against. Reading it as a
   * constraint would resurrect a decision that was already made, against them.
   */
  it('ignores a rejected requirement entirely', () => {
    const constraints = deriveConstraints([
      source({ status: 'rejected', description: 'Everything must be self-hosted.' }),
    ]);

    expect(constraints.selfHostedOnly).toBe(false);
    expect(constraints.selfHostedEvidence).toEqual([]);
  });

  it('finds a technology a requirement mandates by name', () => {
    const constraints = deriveConstraints([
      source({ itemId: 'REQ-014', description: 'The system must use PostgreSQL for all storage.' }),
    ]);

    expect(constraints.mandates).toEqual([
      {
        technologyId: 'postgresql',
        technologyName: 'PostgreSQL',
        category: 'database',
        requirementIds: ['REQ-014'],
      },
    ]);
  });

  it('resolves a mandate written in the informal name', () => {
    const constraints = deriveConstraints([
      source({ description: 'The client requires postgres, not MySQL.' }),
    ]);

    expect(constraints.mandates.map((mandate) => mandate.technologyId)).toContain('postgresql');
  });

  /*
   * Mentioning a technology is not requiring one. "We use X today" is context; a
   * blocking finding against a competing choice needs more than that.
   */
  it('does not turn a mention into a mandate', () => {
    const constraints = deriveConstraints([
      source({ description: 'The current site runs on WordPress and is slow.' }),
    ]);

    expect(constraints.mandates).toEqual([]);
  });

  /*
   * The substring trap. "go" inside "category" would otherwise mandate the Go
   * language on a requirement about categories.
   */
  it('matches technology names as whole words', () => {
    const constraints = deriveConstraints([
      source({
        description: 'The system must use a category-based algorithm to sort the catalogue.',
      }),
    ]);

    expect(constraints.mandates.map((mandate) => mandate.technologyId)).not.toContain('go-backend');
  });

  it('collects every requirement behind one mandate', () => {
    const constraints = deriveConstraints([
      source({ itemId: 'REQ-1', description: 'The system must use MySQL.' }),
      source({ itemId: 'REQ-2', description: 'Reporting must run on MySQL as well.' }),
    ]);

    const mysql = constraints.mandates.find((mandate) => mandate.technologyId === 'mysql');

    // Both sentences require it — "must use" and "must run on" — so both are
    // evidence. The compatibility finding cites every requirement it rests on.
    expect(mysql?.requirementIds).toEqual(['REQ-1', 'REQ-2']);
  });

  it('returns nothing at all when there are no requirements', () => {
    expect(deriveConstraints([]).mandates).toEqual([]);
    expect(deriveConstraints([]).selfHostedOnly).toBe(false);
  });
});

describe('which categories a recommendation run may fill', () => {
  const service = new RecommendationService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    null,
  );

  const plan = (types: Parameters<typeof planCategories>[0]): CategoryApplicabilityEntry[] => [
    ...planCategories(types),
  ];

  const component = (category: TechnologyCategory, status: string): StackComponentDocument =>
    ({ category, status, componentId: `cmp_${category}` }) as unknown as StackComponentDocument;

  it('offers the required and optional categories of a web application', () => {
    const categories = service.categoriesToFill(plan(['WEB_APPLICATION']), [], undefined);

    expect(categories).toContain('web_frontend');
    expect(categories).toContain('backend');
    expect(categories).toContain('database');
  });

  /* The rule that stops a stack growing infrastructure nobody asked for. */
  it('never offers a conditional category that no requirement justified', () => {
    const categories = service.categoriesToFill(plan(['SAAS_PLATFORM']), [], undefined);

    expect(categories).not.toContain('cache');
    expect(categories).not.toContain('message_queue');
    expect(categories).not.toContain('vector_storage');
  });

  it('never offers a category this kind of project does not have', () => {
    const categories = service.categoriesToFill(plan(['BACKEND_API']), [], undefined);

    expect(categories).not.toContain('web_frontend');
    expect(categories).not.toContain('native_ios');
  });

  /* The HYBRID case from the specification, stated directly. */
  it('skips every category the user has already decided', () => {
    const categories = service.categoriesToFill(
      plan(['WEB_APPLICATION']),
      [component('web_frontend', 'USER_SELECTED'), component('backend', 'USER_APPROVED')],
      undefined,
    );

    expect(categories).not.toContain('web_frontend');
    expect(categories).not.toContain('backend');
    expect(categories).toContain('database');
  });

  it('skips a locked category', () => {
    const categories = service.categoriesToFill(
      plan(['WEB_APPLICATION']),
      [component('database', 'LOCKED')],
      undefined,
    );

    expect(categories).not.toContain('database');
  });

  /*
   * Re-running must not churn: a category already holding a suggestion is not
   * offered again, so a second run adds to the stack rather than reshuffling it.
   */
  it('skips a category already holding a suggestion', () => {
    const categories = service.categoriesToFill(
      plan(['WEB_APPLICATION']),
      [component('database', 'AI_RECOMMENDED')],
      undefined,
    );

    expect(categories).not.toContain('database');
  });

  it('offers a category whose only suggestion was rejected', () => {
    const categories = service.categoriesToFill(
      plan(['WEB_APPLICATION']),
      [component('database', 'REJECTED')],
      undefined,
    );

    expect(categories).toContain('database');
  });

  it('narrows to the categories a caller asked about', () => {
    const categories = service.categoriesToFill(plan(['WEB_APPLICATION']), [], ['database']);

    expect(categories).toEqual(['database']);
  });

  it('still refuses a decided category even when it was asked for by name', () => {
    const categories = service.categoriesToFill(
      plan(['WEB_APPLICATION']),
      [component('database', 'USER_SELECTED')],
      ['database'],
    );

    expect(categories).toEqual([]);
  });
});

describe('what the model is allowed to return', () => {
  const valid = {
    recommendations: [
      {
        category: 'database',
        technologyId: 'postgresql',
        rationale: 'The requirements describe orders and payments that must stay consistent.',
        requirementIds: ['REQ-014'],
        benefits: ['Transactional integrity'],
        limitations: [],
        risks: [],
        operationalConsiderations: [],
        alternativeTechnologyId: 'mysql',
        alternativeReason: 'Simpler to operate if the team already runs it.',
        modelConfidence: 0.7,
      },
    ],
    concerns: [],
  };

  it('accepts a well-formed recommendation', () => {
    expect(stackRecommendationOutputSchema.safeParse(valid).success).toBe(true);
  });

  /*
   * The three fields whose absence is the design. A model that could set any of
   * them could take a decision away from the person who made it.
   */
  it('has nowhere to put an authority or a status', () => {
    const withAuthority = {
      ...valid,
      recommendations: [{ ...valid.recommendations[0], authority: 'LOCKED_USER_SELECTION' }],
    };

    expect(stackRecommendationOutputSchema.safeParse(withAuthority).success).toBe(false);
  });

  it('has nowhere to put a version', () => {
    const withVersion = {
      ...valid,
      recommendations: [{ ...valid.recommendations[0], version: '17.2' }],
    };

    expect(stackRecommendationOutputSchema.safeParse(withVersion).success).toBe(false);
  });

  it('has nowhere to put a risk level, so it cannot make anything blocking', () => {
    const withLevel = {
      ...valid,
      concerns: [
        {
          category: 'backend',
          summary: 'A concern',
          impact: 'Something',
          suggestion: 'Something else',
          level: 'BLOCKING',
        },
      ],
    };

    expect(stackRecommendationOutputSchema.safeParse(withLevel).success).toBe(false);
  });

  it('rejects a category the application does not define', () => {
    const invented = {
      ...valid,
      recommendations: [{ ...valid.recommendations[0], category: 'blockchain' }],
    };

    expect(stackRecommendationOutputSchema.safeParse(invented).success).toBe(false);
  });

  it('requires a rationale', () => {
    const empty = {
      ...valid,
      recommendations: [{ ...valid.recommendations[0], rationale: '' }],
    };

    expect(stackRecommendationOutputSchema.safeParse(empty).success).toBe(false);
  });
});

describe('the recommendation prompt', () => {
  const prompt = getPrompt('stack.recommend');

  it('is versioned', () => {
    expect(prompt.version).toBe('v1');
  });

  it('tells the model it may not touch a decided technology', () => {
    expect(prompt.system).toMatch(/DO NOT TOUCH WHAT IS DECIDED/);
    expect(prompt.system).toMatch(/Never recommend replacing one/);
  });

  it('tells the model not to add infrastructure nobody asked for', () => {
    expect(prompt.system).toMatch(/because the project sounds large/);
  });

  it('tells the model not to state a version', () => {
    expect(prompt.system).toMatch(/DO NOT STATE A VERSION/);
  });

  it('keeps the evidence boundary from Phase 4', () => {
    expect(prompt.system).toMatch(/MATERIAL TO ANALYSE/);
    expect(prompt.system).toMatch(/NEVER INVENT/);
  });
});

describe('the deterministic provider’s stack suggestions', () => {
  const request = (categories: string): InferenceRequest => ({
    taskId: 'stack.recommend',
    model: 'test',
    messages: [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: `Categories to fill: ${categories}` },
    ],
    jsonMode: true,
    maxOutputTokens: 2048,
    temperature: 0,
    timeoutMs: 30_000,
    correlationId: 'test',
  });

  it('suggests exactly the categories it was asked about', () => {
    const raw = echoResponse(request('database, backend'));
    const parsed = JSON.parse(raw ?? '{}') as {
      recommendations: { category: string; technologyId: string }[];
    };

    expect(parsed.recommendations.map((item) => item.category)).toEqual(['database', 'backend']);
  });

  it('only ever names a technology that is in the catalogue', () => {
    const raw = echoResponse(
      request('web_frontend, backend, database, hosting, testing, monitoring'),
    );
    const parsed = JSON.parse(raw ?? '{}') as { recommendations: { technologyId: string }[] };
    const ids = new Set(TECHNOLOGY_CATALOG.map((entry) => entry.id));

    for (const item of parsed.recommendations) {
      expect(ids).toContain(item.technologyId);
    }
  });

  it('produces the same suggestions every time, so a fixture can assert them', () => {
    expect(echoResponse(request('database'))).toBe(echoResponse(request('database')));
  });

  /* A stub second-guessing a user's decision would put fiction on the screen. */
  it('raises no concerns about anything a person chose', () => {
    const raw = echoResponse(request('database'));
    const parsed = JSON.parse(raw ?? '{}') as { concerns: unknown[] };

    expect(parsed.concerns).toEqual([]);
  });

  it('says plainly that it is not reasoning', () => {
    const raw = echoResponse(request('database'));
    const parsed = JSON.parse(raw ?? '{}') as { recommendations: { rationale: string }[] };

    expect(parsed.recommendations[0]?.rationale).toMatch(/deterministic test provider/);
  });

  it('validates against the schema the application enforces', () => {
    const raw = echoResponse(request('database, backend, web_frontend'));

    expect(stackRecommendationOutputSchema.safeParse(JSON.parse(raw ?? '{}')).success).toBe(true);
  });
});
