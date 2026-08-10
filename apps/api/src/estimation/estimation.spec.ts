import { MINIMUM_FEATURE_HOURS, OVERHEAD_RULES, totalRoleEffort } from '@wdrg/contracts';

import {
  classifyTask,
  estimateUnit,
  overheadUnits,
  splitAcrossRoles,
  technologyImpact,
  type RequirementInput,
  type StackContextInput,
} from './estimation-engine';
import { estimationAssessmentSchema } from './estimation-schema';
import { echoResponse } from '../analysis/providers/echo-scenario';
import { getPrompt } from '../analysis/prompts/prompt-registry';
import type { InferenceRequest } from '../analysis/providers/inference.types';

/**
 * The estimation logic that runs before anything reaches a database.
 *
 * Three properties are pinned here, and each is a place a plausible change would
 * break the phase's promises:
 *
 * - **The locked stack is priced, never replaced.** Every technology driver
 *   names a technology from the locked snapshot, and there is no path to
 *   changing one.
 * - **Roles follow the project.** An API-only project cannot acquire frontend
 *   hours, and hours are never silently lost when a role does not apply.
 * - **The model returns judgement, not arithmetic.** Its schema has nowhere to
 *   put an hours figure.
 */

function requirement(overrides: Partial<RequirementInput> = {}): RequirementInput {
  return {
    itemId: 'REQ-001',
    title: 'Staff can record a timesheet',
    statement: 'Staff must sign in and record their weekly timesheets.',
    category: 'functional',
    ...overrides,
  };
}

const WEB_STACK: StackContextInput = {
  technologies: [
    { category: 'web_frontend', technologyId: 'react', name: 'React' },
    { category: 'backend', technologyId: 'nestjs', name: 'NestJS' },
    { category: 'database', technologyId: 'postgresql', name: 'PostgreSQL' },
  ],
  roles: ['BACKEND', 'FRONTEND', 'UI_UX', 'QA', 'DEVOPS', 'BA', 'PM', 'SOLUTION_ARCHITECT'],
};

const API_STACK: StackContextInput = {
  technologies: [
    { category: 'backend', technologyId: 'nestjs', name: 'NestJS' },
    { category: 'database', technologyId: 'postgresql', name: 'PostgreSQL' },
  ],
  roles: ['BACKEND', 'QA', 'DEVOPS', 'BA', 'PM', 'SOLUTION_ARCHITECT'],
};

describe('classifying what kind of work a requirement describes', () => {
  it('reads an integration from the words', () => {
    expect(
      classifyTask(
        requirement({ statement: 'Orders must be sent to the third-party warehouse system.' }),
      ),
    ).toBe('integration');
  });

  it('reads a screen from the words', () => {
    expect(classifyTask(requirement({ statement: 'A dashboard must display open orders.' }))).toBe(
      'ui_implementation',
    );
  });

  it('follows the requirement category where the analysis set one', () => {
    expect(classifyTask(requirement({ category: 'integration' }))).toBe('integration');
    expect(classifyTask(requirement({ category: 'data' }))).toBe('data_modelling');
    expect(
      classifyTask(requirement({ category: 'non_functional', nfrDimension: 'security' })),
    ).toBe('validation');
  });

  /* A miss lands on the safe default rather than on something confident. */
  it('falls back to business logic rather than guessing', () => {
    expect(classifyTask(requirement({ statement: 'It should be nice.' }))).toBe('business_logic');
  });
});

describe('splitting hours across roles', () => {
  it('uses only the roles the project has', () => {
    const split = splitAcrossRoles(100, 'crud', API_STACK.roles);

    expect(Object.keys(split)).not.toContain('FRONTEND');
    expect(Object.keys(split)).toContain('BACKEND');
  });

  /*
   * The share that belonged to a missing role is redistributed, not dropped.
   * Dropping it would silently discount the estimate by however much frontend
   * work an API project "did not" need.
   */
  it('never loses hours when a role does not apply', () => {
    expect(totalRoleEffort(splitAcrossRoles(100, 'crud', API_STACK.roles))).toBeCloseTo(100, 1);
    expect(totalRoleEffort(splitAcrossRoles(100, 'crud', WEB_STACK.roles))).toBeCloseTo(100, 1);
  });

  /*
   * A multi-platform product builds its interfaces twice. Handing the whole
   * share to whichever role the table names would cost the phones at nothing.
   */
  it('splits interface work between web and mobile when the project has both', () => {
    const split = splitAcrossRoles(100, 'crud', ['FRONTEND', 'MOBILE', 'BACKEND', 'QA']);

    expect(split.FRONTEND).toBeGreaterThan(0);
    expect(split.MOBILE).toBeGreaterThan(0);
    expect(split.FRONTEND).toBeCloseTo(split.MOBILE!, 2);
    expect(totalRoleEffort(split)).toBeCloseTo(100, 1);
  });

  it('gives interface work entirely to mobile when there is no web frontend', () => {
    const split = splitAcrossRoles(100, 'crud', ['MOBILE', 'BACKEND', 'QA']);

    expect(split.MOBILE).toBeGreaterThan(0);
    expect(split.FRONTEND).toBeUndefined();
  });

  it('puts design work on the design role where the project has one', () => {
    expect(Object.keys(splitAcrossRoles(100, 'ui_design', WEB_STACK.roles))).toContain('UI_UX');
  });

  it('falls back to one role rather than losing the hours entirely', () => {
    const split = splitAcrossRoles(50, 'ai_ml', ['BACKEND']);

    expect(totalRoleEffort(split)).toBe(50);
  });
});

describe('what the locked stack costs', () => {
  /* The specification's clearest example, worked through. */
  it('charges twice for two native platforms', () => {
    const twoPlatforms: StackContextInput = {
      technologies: [
        { category: 'native_android', technologyId: 'kotlin-android', name: 'Kotlin (Android)' },
        { category: 'native_ios', technologyId: 'swift-ios', name: 'Swift (iOS)' },
        { category: 'backend', technologyId: 'nestjs', name: 'NestJS' },
      ],
      roles: ['MOBILE', 'BACKEND', 'QA', 'DEVOPS', 'BA', 'PM'],
    };

    const drivers = technologyImpact(twoPlatforms, 'ui_implementation', requirement());

    expect(drivers).toHaveLength(1);
    expect(drivers[0]?.summary).toContain('separate codebases');
    expect(drivers[0]?.additionalHours).toBeGreaterThan(0);
    expect(drivers[0]?.technologyId).toBe('swift-ios');
  });

  it('charges once for a cross-platform framework', () => {
    const crossPlatform: StackContextInput = {
      technologies: [
        { category: 'mobile_framework', technologyId: 'flutter', name: 'Flutter' },
        { category: 'backend', technologyId: 'nestjs', name: 'NestJS' },
      ],
      roles: ['MOBILE', 'BACKEND', 'QA', 'DEVOPS', 'BA', 'PM'],
    };

    expect(technologyImpact(crossPlatform, 'ui_implementation', requirement())).toEqual([]);
  });

  it('charges for running on the client’s own infrastructure', () => {
    const onPremise: StackContextInput = {
      technologies: [
        { category: 'hosting', technologyId: 'on-premise', name: 'Client’s own infrastructure' },
      ],
      roles: ['DEVOPS', 'BACKEND', 'QA', 'BA', 'PM'],
    };

    const drivers = technologyImpact(onPremise, 'infrastructure', requirement());

    expect(drivers[0]?.technologyId).toBe('on-premise');
    expect(drivers[0]?.summary).toContain('client’s own infrastructure');
  });

  it('charges for a model whose outputs vary', () => {
    const aiStack: StackContextInput = {
      technologies: [
        { category: 'ai_model', technologyId: 'open-weights-model', name: 'Open-weights model' },
      ],
      roles: ['AI_ML', 'BACKEND', 'QA', 'BA', 'PM'],
    };

    expect(technologyImpact(aiStack, 'ai_ml', requirement())[0]?.additionalHours).toBeGreaterThan(
      0,
    );
  });

  /* Every driver traces to something in the locked snapshot. */
  it('names a technology and a requirement on every driver', () => {
    const twoPlatforms: StackContextInput = {
      technologies: [
        { category: 'native_android', technologyId: 'kotlin-android', name: 'Kotlin (Android)' },
        { category: 'native_ios', technologyId: 'swift-ios', name: 'Swift (iOS)' },
      ],
      roles: ['MOBILE', 'QA', 'BA', 'PM'],
    };

    for (const driver of technologyImpact(twoPlatforms, 'crud', requirement())) {
      expect(driver.requirementIds).toEqual(['REQ-001']);
      expect(driver.technologyId).toBeTruthy();
    }
  });

  /*
   * There is no code path from the estimator to the stack. This asserts the
   * shape rather than the behaviour: a driver can add hours and nothing else.
   */
  it('has no way to change a technology', () => {
    const drivers = technologyImpact(WEB_STACK, 'integration', requirement());

    for (const driver of drivers) {
      expect(Object.keys(driver).sort()).toEqual(
        expect.arrayContaining(['kind', 'requirementIds', 'summary']),
      );
      expect(Object.keys(driver)).not.toContain('replaceWith');
      expect(Object.keys(driver)).not.toContain('technology');
    }
  });
});

describe('estimating one requirement', () => {
  it('produces hours, a range and an explanation', () => {
    const draft = estimateUnit(requirement(), WEB_STACK);

    expect(draft.totalHours).toBeGreaterThanOrEqual(MINIMUM_FEATURE_HOURS);
    expect(draft.range.optimistic).toBeLessThanOrEqual(draft.range.expected);
    expect(draft.range.expected).toBeLessThanOrEqual(draft.range.conservative);
    expect(draft.complexityExplanation.length).toBeGreaterThan(10);
  });

  it('splits the hours across the roles the project has', () => {
    const draft = estimateUnit(requirement(), API_STACK);

    expect(Object.keys(draft.effort)).not.toContain('FRONTEND');
    expect(totalRoleEffort(draft.effort)).toBeCloseTo(draft.totalHours, 1);
  });

  it('costs a workflow more than a plain screen', () => {
    const plain = estimateUnit(
      requirement({ statement: 'A page must display the list of clients.' }),
      WEB_STACK,
    );
    const workflow = estimateUnit(
      requirement({
        statement:
          'A manager must approve every quote in a multi-step workflow, with rules depending on value.',
      }),
      WEB_STACK,
    );

    expect(workflow.totalHours).toBeGreaterThan(plain.totalHours);
  });

  /*
   * Length is not complexity. A long, simple requirement must not cost more
   * than a short, hard one.
   */
  it('does not cost a long requirement more for being long', () => {
    const sentence = 'A page must display the list of clients.';
    const short = estimateUnit(requirement({ statement: sentence }), WEB_STACK);
    /* Same content, said at six times the length. */
    const long = estimateUnit(requirement({ statement: sentence.repeat(6) }), WEB_STACK);

    expect(long.totalHours).toBe(short.totalHours);
    expect(long.complexity).toBe(short.complexity);
  });

  /* And a short hard requirement costs more than a long easy one. */
  it('costs a short hard requirement more than a long easy one', () => {
    const hard = estimateUnit(
      requirement({
        statement:
          'A manager must approve every payment in a multi-step workflow, with rules depending on value, integrating with the third-party ledger.',
      }),
      WEB_STACK,
    );
    const easy = estimateUnit(
      requirement({
        statement: 'A page must display the list of clients. '.repeat(10),
      }),
      WEB_STACK,
    );

    expect(hard.totalHours).toBeGreaterThan(easy.totalHours);
  });

  it('takes the model’s proposals as inputs to the same arithmetic', () => {
    const withoutModel = estimateUnit(requirement(), WEB_STACK);
    const withModel = estimateUnit(requirement(), WEB_STACK, {
      proposedComplexity: 'VERY_HIGH',
      proposedDrivers: ['workflow_depth', 'integration_complexity', 'realtime_behaviour'],
    });

    expect(withModel.totalHours).toBeGreaterThan(withoutModel.totalHours);
    /* And the explanation still comes from the drivers, not from the model. */
    expect(withModel.complexityExplanation).toContain('multi-step workflow');
  });

  it('raises uncertainty rather than assuming away an unknown', () => {
    const draft = estimateUnit(
      requirement({ statement: 'Orders must reach the third-party warehouse system.' }),
      WEB_STACK,
    );

    expect(draft.uncertainty).not.toBe('LOW');
    expect(draft.range.conservative / draft.range.expected).toBeGreaterThan(1.2);
  });

  it('is deterministic', () => {
    expect(estimateUnit(requirement(), WEB_STACK)).toEqual(estimateUnit(requirement(), WEB_STACK));
  });
});

describe('delivery overhead', () => {
  it('produces a line per applicable activity', () => {
    const units = overheadUnits(1_000, WEB_STACK.roles);

    expect(units.length).toBeGreaterThan(5);

    for (const unit of units) {
      expect(unit.overheadActivity).toBeTruthy();
      expect(unit.totalHours).toBeGreaterThan(0);
    }
  });

  it('scales the proportional ones with the work and leaves the fixed ones alone', () => {
    const small = overheadUnits(100, WEB_STACK.roles);
    const large = overheadUnits(1_000, WEB_STACK.roles);

    const review = (units: readonly { overheadActivity?: string; totalHours: number }[]) =>
      units.find((unit) => unit.overheadActivity === 'code_review')?.totalHours ?? 0;
    const setup = (units: readonly { overheadActivity?: string; totalHours: number }[]) =>
      units.find((unit) => unit.overheadActivity === 'environment_setup')?.totalHours ?? 0;

    expect(review(large)).toBeCloseTo(review(small) * 10, 1);
    expect(setup(large)).toBe(setup(small));
  });

  it('skips an activity whose role the project does not have', () => {
    const units = overheadUnits(1_000, ['QA', 'PM']);
    const roles = units.flatMap((unit) => Object.keys(unit.effort));

    expect(roles).not.toContain('DEVOPS');
    expect(roles).not.toContain('SOLUTION_ARCHITECT');
  });

  /* Explicit activities, not a percentage nobody can evaluate. */
  it('explains each line in words', () => {
    for (const unit of overheadUnits(500, WEB_STACK.roles)) {
      expect(unit.rationale).toMatch(/fixed|% of implementation effort/);
    }

    expect(OVERHEAD_RULES.length).toBeGreaterThan(5);
  });
});

describe('what the model is allowed to return', () => {
  const valid = {
    assessments: [
      {
        requirementId: 'REQ-014',
        taskCategory: 'business_logic',
        complexity: 'MEDIUM',
        complexityDrivers: ['workflow_depth'],
        uncertaintySources: [],
        rationale: 'A multi-step approval with rules that vary by value.',
      },
    ],
  };

  it('accepts a well-formed assessment', () => {
    expect(estimationAssessmentSchema.safeParse(valid).success).toBe(true);
  });

  /* The absence that makes the hybrid model a hybrid model. */
  it('has nowhere to put hours', () => {
    for (const field of ['hours', 'totalHours', 'effort', 'estimatedHours']) {
      expect(
        estimationAssessmentSchema.safeParse({
          assessments: [{ ...valid.assessments[0], [field]: 40 }],
        }).success,
      ).toBe(false);
    }
  });

  it('has nowhere to put a role split', () => {
    expect(
      estimationAssessmentSchema.safeParse({
        assessments: [{ ...valid.assessments[0], roles: { BACKEND: 10 } }],
      }).success,
    ).toBe(false);
  });

  it('has nowhere to name a technology', () => {
    expect(
      estimationAssessmentSchema.safeParse({
        assessments: [{ ...valid.assessments[0], technology: 'mongodb' }],
      }).success,
    ).toBe(false);
  });

  it('has nowhere to put a dependency or a date', () => {
    expect(
      estimationAssessmentSchema.safeParse({
        assessments: [{ ...valid.assessments[0], dependsOn: ['REQ-013'] }],
      }).success,
    ).toBe(false);
    expect(
      estimationAssessmentSchema.safeParse({
        assessments: [{ ...valid.assessments[0], startDate: '2026-09-01' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a complexity or driver the application does not define', () => {
    expect(
      estimationAssessmentSchema.safeParse({
        assessments: [{ ...valid.assessments[0], complexity: 'EXTREME' }],
      }).success,
    ).toBe(false);
    expect(
      estimationAssessmentSchema.safeParse({
        assessments: [{ ...valid.assessments[0], complexityDrivers: ['vibes'] }],
      }).success,
    ).toBe(false);
  });

  it('requires a rationale', () => {
    expect(
      estimationAssessmentSchema.safeParse({
        assessments: [{ ...valid.assessments[0], rationale: '' }],
      }).success,
    ).toBe(false);
  });
});

describe('the estimation prompt', () => {
  const prompt = getPrompt('estimation.assess');

  it('is versioned', () => {
    expect(prompt.version).toBe('v1');
  });

  it('tells the model not to return hours', () => {
    expect(prompt.system).toMatch(/DO NOT RETURN HOURS/);
  });

  it('tells the model the technologies are already decided', () => {
    expect(prompt.system).toMatch(/DO NOT CHANGE THE TECHNOLOGIES/);
    expect(prompt.system).toMatch(/never by proposing a different/);
  });

  it('tells the model length is not complexity', () => {
    expect(prompt.system).toMatch(/LENGTH IS NOT COMPLEXITY/);
  });

  it('keeps the evidence boundary from Phase 4', () => {
    expect(prompt.system).toMatch(/MATERIAL TO ANALYSE/);
    expect(prompt.system).toMatch(/NEVER INVENT/);
  });
});

describe('the deterministic provider’s assessments', () => {
  const request = (blocks: readonly { id: string; text: string }[]): InferenceRequest => ({
    taskId: 'estimation.assess',
    model: 'test',
    messages: [
      { role: 'system', content: 'instructions' },
      {
        role: 'user',
        content: `<<<REQUIREMENT_EVIDENCE>>>\n${blocks
          .map((block) => `[${block.id}]\n${block.text}`)
          .join('\n\n')}\n<<<END_REQUIREMENT_EVIDENCE>>>`,
      },
    ],
    jsonMode: true,
    maxOutputTokens: 4_096,
    temperature: 0,
    timeoutMs: 30_000,
    correlationId: 'test',
  });

  it('assesses every requirement it was given', () => {
    const raw = echoResponse(
      request([
        { id: 'REQ-001', text: 'A manager must approve every quote.' },
        { id: 'REQ-002', text: 'A page must display open orders.' },
      ]),
    );
    const parsed = JSON.parse(raw ?? '{}') as { assessments: { requirementId: string }[] };

    expect(parsed.assessments.map((item) => item.requirementId)).toEqual(['REQ-001', 'REQ-002']);
  });

  it('validates against the schema the application enforces', () => {
    const raw = echoResponse(
      request([{ id: 'REQ-001', text: 'Orders reach the third-party warehouse system.' }]),
    );

    expect(estimationAssessmentSchema.safeParse(JSON.parse(raw ?? '{}')).success).toBe(true);
  });

  it('says plainly that it is not reasoning', () => {
    const raw = echoResponse(request([{ id: 'REQ-001', text: 'Something.' }]));
    const parsed = JSON.parse(raw ?? '{}') as { assessments: { rationale: string }[] };

    expect(parsed.assessments[0]?.rationale).toMatch(/deterministic test provider/);
  });

  it('produces the same assessment every time, so a fixture can assert it', () => {
    const input = request([{ id: 'REQ-001', text: 'A manager must approve every quote.' }]);

    expect(echoResponse(input)).toBe(echoResponse(input));
  });
});
