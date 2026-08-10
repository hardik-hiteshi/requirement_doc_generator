import { describe, expect, it } from 'vitest';

import { COMPLEXITY_MULTIPLIERS, deriveComplexity, deriveUncertainty } from './complexity.contract';
import {
  AI_ASSISTANCE_FACTORS,
  BASE_HOURS,
  MINIMUM_FEATURE_HOURS,
  OVERHEAD_RULES,
  PRODUCTIVITY_MODEL_VERSION,
  baseEffortHours,
  isPlausibleHours,
} from './productivity-model';
import { aggregateEffort, rangeFor, rangeWidth, sumRanges } from './effort-range';
import { applicableRoles, sumRoleEffort, totalRoleEffort } from './role.contract';
import {
  DEFAULT_CALENDAR,
  addWorkingDays,
  isMaterialCalendarChange,
  isWorkingDay,
  timelineWorkingDays,
  workingDaysBetween,
  type WorkingCalendar,
} from './calendar.contract';
import {
  SUSTAINABLE_UTILISATION,
  calculateCapacity,
  isMaterialCapacityChange,
  peopleForHours,
  recommendStaffing,
  type CapacityLine,
  type TeamPlan,
} from './capacity.contract';
import { buildSchedule, durationFor, topologicalOrder } from './scheduling';
import {
  detectCycles,
  validateDependencies,
  type Dependency,
  type DependencyType,
} from './dependency.contract';
import { assessFeasibility, feasibilityNeedsAcknowledgement } from './feasibility';
import { isUserAuthored } from './estimate-unit.contract';

/**
 * The arithmetic behind every date and every number in a signed proposal.
 *
 * Three properties are pinned hardest, because each is a way the phase could
 * look correct and be wrong:
 *
 * - **Effort, duration and capacity stay separate.** No test here lets hours
 *   turn into weeks without a team and a dependency graph in between.
 * - **The scheduler is deterministic.** Same input, same dates, every time.
 * - **The stated timeline is never changed.** Feasibility reports; it does not
 *   adjust.
 */

/* ---------------------------------------------------------- complexity */

describe('complexity', () => {
  it('calls a feature with nothing notable about it trivial', () => {
    const assessment = deriveComplexity([]);

    expect(assessment.level).toBe('TRIVIAL');
    expect(assessment.explanation).toContain('ordinary work');
  });

  it('rises with the number and weight of drivers', () => {
    expect(deriveComplexity(['validation_complexity']).level).toBe('LOW');
    expect(deriveComplexity(['workflow_depth', 'business_rules']).level).toBe('MEDIUM');
    expect(
      deriveComplexity(['workflow_depth', 'business_rules', 'integration_complexity']).level,
    ).toBe('HIGH');
    expect(
      deriveComplexity([
        'workflow_depth',
        'business_rules',
        'integration_complexity',
        'realtime_behaviour',
        'offline_behaviour',
      ]).level,
    ).toBe('VERY_HIGH');
  });

  it('weights the things we do not control more heavily', () => {
    const controlled = deriveComplexity(['validation_complexity', 'deployment_complexity']);
    const uncontrolled = deriveComplexity(['integration_complexity', 'external_api_uncertainty']);

    expect(uncontrolled.score).toBeGreaterThan(controlled.score);
  });

  it('ignores repeated drivers', () => {
    expect(deriveComplexity(['workflow_depth', 'workflow_depth']).score).toBe(
      deriveComplexity(['workflow_depth']).score,
    );
  });

  /* The rule the specification states outright. */
  it('never consults the requirement text', () => {
    expect(deriveComplexity.length).toBe(1);
    expect(deriveComplexity(['business_rules']).level).toBe(
      deriveComplexity(['business_rules']).level,
    );
  });

  it('explains itself from the drivers it used', () => {
    const assessment = deriveComplexity(['integration_complexity', 'security_requirements']);

    expect(assessment.explanation).toContain('system we do not own');
    expect(assessment.explanation).toContain('security requirements');
  });
});

describe('uncertainty', () => {
  it('is low when nothing is unknown', () => {
    expect(deriveUncertainty([]).level).toBe('LOW');
  });

  /* Independent unknowns compound; they do not add. */
  it('reaches high on two independent unknowns', () => {
    expect(deriveUncertainty(['external_api_undocumented']).level).toBe('MEDIUM');
    expect(deriveUncertainty(['external_api_undocumented', 'no_sandbox_available']).level).toBe(
      'HIGH',
    );
  });
});

/* ------------------------------------------------------- productivity */

describe('the productivity model', () => {
  it('is versioned, so an old estimate stays interpretable', () => {
    expect(PRODUCTIVITY_MODEL_VERSION).toMatch(/^v\d+$/);
  });

  /*
   * The shape of this table is the argument of the whole phase. If somebody
   * ever sets analysis or coordination below 1, they have claimed a model
   * shortens a conversation.
   */
  it('gives no AI discount to analysis or coordination', () => {
    expect(AI_ASSISTANCE_FACTORS.analysis).toBe(1);
    expect(AI_ASSISTANCE_FACTORS.coordination).toBe(1);
  });

  it('discounts scaffolding far more than integration', () => {
    expect(AI_ASSISTANCE_FACTORS.scaffolding).toBeLessThan(AI_ASSISTANCE_FACTORS.integration);
    expect(AI_ASSISTANCE_FACTORS.integration).toBeGreaterThan(0.85);
  });

  it('never discounts anything to nothing', () => {
    for (const factor of Object.values(AI_ASSISTANCE_FACTORS)) {
      expect(factor).toBeGreaterThan(0.4);
    }
  });

  /* The rule against unrealistically tiny estimates, made mechanical. */
  it('never produces a feature below the floor', () => {
    const tiny = baseEffortHours({ category: 'scaffolding', complexity: 'TRIVIAL' });

    expect(tiny).toBeGreaterThanOrEqual(MINIMUM_FEATURE_HOURS);
  });

  it('is the base times the complexity multiplier times the AI factor', () => {
    const hours = baseEffortHours({ category: 'business_logic', complexity: 'MEDIUM' });
    const expected =
      BASE_HOURS.business_logic *
      COMPLEXITY_MULTIPLIERS.MEDIUM *
      AI_ASSISTANCE_FACTORS.business_logic;

    expect(hours).toBeCloseTo(expected, 2);
  });

  it('scales with quantity', () => {
    const one = baseEffortHours({ category: 'crud', complexity: 'LOW' });
    const three = baseEffortHours({ category: 'crud', complexity: 'LOW', quantity: 3 });

    expect(three).toBeCloseTo(one * 3, 2);
  });

  it('refuses impossible hours, including from a person', () => {
    expect(isPlausibleHours(40)).toBe(true);
    expect(isPlausibleHours(0)).toBe(true);
    expect(isPlausibleHours(-1)).toBe(false);
    expect(isPlausibleHours(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isPlausibleHours(Number.NaN)).toBe(false);
    expect(isPlausibleHours(500_000)).toBe(false);
  });

  it('names overhead as activities rather than a percentage on top', () => {
    expect(OVERHEAD_RULES.length).toBeGreaterThan(5);

    for (const rule of OVERHEAD_RULES) {
      expect(rule.proportion !== undefined || rule.fixedHours !== undefined).toBe(true);
      expect(rule.role.length).toBeGreaterThan(1);
    }
  });

  /* Fixed overheads are why a small project feels disproportionately costly. */
  it('has both fixed and proportional overheads', () => {
    expect(OVERHEAD_RULES.some((rule) => rule.fixedHours !== undefined)).toBe(true);
    expect(OVERHEAD_RULES.some((rule) => rule.proportion !== undefined)).toBe(true);
  });
});

/* ------------------------------------------------------------- ranges */

describe('effort ranges', () => {
  it('widens with uncertainty', () => {
    expect(rangeWidth(rangeFor(100, 'HIGH'))).toBeGreaterThan(rangeWidth(rangeFor(100, 'LOW')));
  });

  /* Software overruns more often than it comes in early. */
  it('is asymmetric, leaning to the conservative side', () => {
    const range = rangeFor(100, 'MEDIUM');

    expect(range.expected - range.optimistic).toBeLessThan(range.conservative - range.expected);
  });

  it('keeps the bands ordered', () => {
    for (const uncertainty of ['LOW', 'MEDIUM', 'HIGH'] as const) {
      const range = rangeFor(80, uncertainty);

      expect(range.optimistic).toBeLessThanOrEqual(range.expected);
      expect(range.expected).toBeLessThanOrEqual(range.conservative);
    }
  });

  /* No flat padding anywhere: a well-understood feature is barely widened. */
  it('does not inflate a well-understood feature', () => {
    const range = rangeFor(100, 'LOW');

    expect(range.expected).toBe(100);
    expect(range.conservative).toBeLessThanOrEqual(120);
  });

  it('adds band by band', () => {
    const total = sumRanges([rangeFor(10, 'LOW'), rangeFor(20, 'LOW')]);

    expect(total.expected).toBe(30);
  });

  it('keeps implementation and overhead apart in the totals', () => {
    const totals = aggregateEffort([
      { range: rangeFor(100, 'LOW'), byRole: { BACKEND: 100 }, isImplementation: true },
      { range: rangeFor(20, 'LOW'), byRole: { QA: 20 }, isImplementation: false },
    ]);

    expect(totals.implementationHours).toBe(100);
    expect(totals.overheadHours).toBe(20);
    expect(totals.totalHours).toBe(120);
  });
});

/* -------------------------------------------------------------- roles */

describe('which roles a project has', () => {
  it('gives an API-only project no frontend and no design', () => {
    const roles = applicableRoles({
      projectTypes: ['BACKEND_API'],
      stackCategories: ['backend', 'database'],
    });

    expect(roles).toContain('BACKEND');
    expect(roles).not.toContain('FRONTEND');
    expect(roles).not.toContain('UI_UX');
    expect(roles).not.toContain('MOBILE');
  });

  it('gives a static website no backend', () => {
    const roles = applicableRoles({
      projectTypes: ['WEBSITE'],
      stackCategories: ['web_frontend'],
    });

    expect(roles).toContain('FRONTEND');
    expect(roles).toContain('UI_UX');
    expect(roles).not.toContain('BACKEND');
  });

  /* The stack is the locked record; the brief is prose. */
  it('follows the locked stack rather than the project type', () => {
    const roles = applicableRoles({
      projectTypes: ['MOBILE_APPLICATION'],
      stackCategories: ['backend', 'database'],
    });

    expect(roles).not.toContain('MOBILE');
  });

  it('adds mobile when the stack has a mobile technology', () => {
    expect(
      applicableRoles({
        projectTypes: ['CROSS_PLATFORM_MOBILE'],
        stackCategories: ['mobile_framework'],
      }),
    ).toContain('MOBILE');
  });

  it('always includes the roles every project has', () => {
    const roles = applicableRoles({ projectTypes: ['WEBSITE'], stackCategories: ['web_frontend'] });

    expect(roles).toEqual(expect.arrayContaining(['QA', 'DEVOPS', 'BA', 'PM']));
  });

  /* A brochure site does not need a solution architect. */
  it('does not put an architect on a static website', () => {
    expect(
      applicableRoles({ projectTypes: ['WEBSITE'], stackCategories: ['web_frontend'] }),
    ).not.toContain('SOLUTION_ARCHITECT');
  });

  it('includes custom roles the project configured', () => {
    const roles = applicableRoles({
      projectTypes: ['WEB_APPLICATION'],
      stackCategories: ['backend'],
      customRoles: [{ key: 'custom:security-reviewer', label: 'Security reviewer' }],
    });

    expect(roles).toContain('custom:security-reviewer');
  });
});

describe('role effort arithmetic', () => {
  it('sums across roles', () => {
    expect(totalRoleEffort({ BACKEND: 10.5, QA: 4.25 })).toBe(14.75);
  });

  it('merges maps without losing a role', () => {
    expect(sumRoleEffort({ BACKEND: 10 }, { BACKEND: 5, QA: 3 })).toEqual({ BACKEND: 15, QA: 3 });
  });

  /* Absent is not zero: it means no work of that kind. */
  it('leaves an absent role absent', () => {
    expect(Object.keys(sumRoleEffort({ BACKEND: 10 }, { QA: 3 }))).toEqual(['BACKEND', 'QA']);
    expect(sumRoleEffort({ BACKEND: 10 }).FRONTEND).toBeUndefined();
  });
});

/* ----------------------------------------------------------- calendar */

describe('the working calendar', () => {
  const calendar: WorkingCalendar = {
    ...DEFAULT_CALENDAR,
    holidays: ['2026-08-31'],
  };

  /* Not eight. The default is visible and argued for, not buried. */
  it('defaults to six and a half productive hours, not eight', () => {
    expect(DEFAULT_CALENDAR.hoursPerDay).toBe(6.5);
  });

  it('knows a weekend is not a working day', () => {
    expect(isWorkingDay('2026-08-08', calendar)).toBe(false);
    expect(isWorkingDay('2026-08-09', calendar)).toBe(false);
    expect(isWorkingDay('2026-08-10', calendar)).toBe(true);
  });

  it('knows a holiday is not a working day', () => {
    expect(isWorkingDay('2026-08-31', calendar)).toBe(false);
  });

  /* One working day starting Monday finishes on Monday. */
  it('counts the first day as day one', () => {
    expect(addWorkingDays('2026-08-10', 1, calendar)).toBe('2026-08-10');
    expect(addWorkingDays('2026-08-10', 5, calendar)).toBe('2026-08-14');
  });

  it('skips the weekend', () => {
    expect(addWorkingDays('2026-08-10', 6, calendar)).toBe('2026-08-17');
  });

  it('skips a holiday', () => {
    // 31 August is a holiday, so the fifth working day from 31 August lands a
    // day later than it otherwise would.
    expect(addWorkingDays('2026-08-31', 1, calendar)).toBe('2026-09-01');
  });

  it('counts working days between two dates inclusively', () => {
    expect(workingDaysBetween('2026-08-10', '2026-08-14', calendar)).toBe(5);
    expect(workingDaysBetween('2026-08-10', '2026-08-17', calendar)).toBe(6);
  });

  it('counts nothing when the end precedes the start', () => {
    expect(workingDaysBetween('2026-08-14', '2026-08-10', calendar)).toBe(0);
  });

  it('honours a working week that is not Monday to Friday', () => {
    const sundayToThursday: WorkingCalendar = {
      ...DEFAULT_CALENDAR,
      workingWeekdays: [0, 1, 2, 3, 4],
    };

    expect(isWorkingDay('2026-08-09', sundayToThursday)).toBe(true);
    expect(isWorkingDay('2026-08-07', sundayToThursday)).toBe(false);
  });

  it('converts a stated timeline into working days', () => {
    expect(timelineWorkingDays({ mode: 'WORKING_DAYS', workingDays: 40 }, calendar)).toBe(40);
    expect(timelineWorkingDays({ mode: 'WEEKS', weeks: 8 }, calendar)).toBe(40);
    expect(timelineWorkingDays({ mode: 'MONTHS', months: 3 }, calendar)).toBe(65);
  });

  /* A deadline with no start date is a date, not a duration. */
  it('refuses to measure a deadline with no start date', () => {
    expect(
      timelineWorkingDays({ mode: 'FIXED_DEADLINE', deadline: '2026-12-01' }, calendar),
    ).toBeNull();
    expect(
      timelineWorkingDays(
        { mode: 'FIXED_DEADLINE', deadline: '2026-08-14' },
        calendar,
        '2026-08-10',
      ),
    ).toBe(5);
  });

  it('notices a calendar change that would alter what fits', () => {
    expect(isMaterialCalendarChange(DEFAULT_CALENDAR, DEFAULT_CALENDAR)).toBe(false);
    expect(
      isMaterialCalendarChange(DEFAULT_CALENDAR, { ...DEFAULT_CALENDAR, hoursPerDay: 8 }),
    ).toBe(true);
    expect(
      isMaterialCalendarChange(DEFAULT_CALENDAR, { ...DEFAULT_CALENDAR, holidays: ['2026-12-25'] }),
    ).toBe(true);
  });
});

/* ----------------------------------------------------------- capacity */

describe('capacity', () => {
  const line = (overrides: Partial<CapacityLine> = {}): CapacityLine => ({
    role: 'BACKEND',
    people: 2,
    productiveHoursPerDay: 6.5,
    workingDaysPerWeek: 5,
    availability: 1,
    availableFromDay: 0,
    ...overrides,
  });

  const team = (lines: CapacityLine[]): TeamPlan => ({ supplied: true, lines });

  it('is people times hours times availability times days', () => {
    const result = calculateCapacity({
      plannedEffort: { BACKEND: 100 },
      team: team([line()]),
      calendar: DEFAULT_CALENDAR,
      availableWorkingDays: 20,
    });

    // 2 people × 6.5 h × 100% × 20 days = 260 hours.
    expect(result.totalAvailableHours).toBe(260);
    expect(result.totalGapHours).toBe(0);
  });

  it('reduces capacity for part-time availability', () => {
    const result = calculateCapacity({
      plannedEffort: { BACKEND: 100 },
      team: team([line({ availability: 0.5 })]),
      calendar: DEFAULT_CALENDAR,
      availableWorkingDays: 20,
    });

    expect(result.totalAvailableHours).toBe(130);
  });

  it('reduces capacity for a late start', () => {
    const result = calculateCapacity({
      plannedEffort: { BACKEND: 100 },
      team: team([line({ availableFromDay: 10 })]),
      calendar: DEFAULT_CALENDAR,
      availableWorkingDays: 20,
    });

    expect(result.totalAvailableHours).toBe(130);
  });

  it('reports a gap when the work does not fit', () => {
    const result = calculateCapacity({
      plannedEffort: { BACKEND: 400 },
      team: team([line()]),
      calendar: DEFAULT_CALENDAR,
      availableWorkingDays: 20,
    });

    expect(result.totalGapHours).toBe(140);
    expect(result.byRole[0]?.additionalPeople).toBeGreaterThan(0);
  });

  /* Nobody has said what the team is, which is not the same as "nobody". */
  it('says capacity is unknown rather than zero when no team was supplied', () => {
    const result = calculateCapacity({
      plannedEffort: { BACKEND: 100 },
      team: { supplied: false, lines: [] },
      calendar: DEFAULT_CALENDAR,
      availableWorkingDays: 20,
    });

    expect(result.capacityUnknown).toBe(true);
  });

  it('flags a role loaded above what a person sustains', () => {
    const result = calculateCapacity({
      plannedEffort: { BACKEND: 250 },
      team: team([line()]),
      calendar: DEFAULT_CALENDAR,
      availableWorkingDays: 20,
    });

    expect(result.totalGapHours).toBe(0);
    expect(result.byRole[0]!.utilisation).toBeGreaterThan(SUSTAINABLE_UTILISATION);
    expect(result.overloadedRoles).toContain('BACKEND');
  });

  it('never reports an infinite utilisation, which cannot be stored', () => {
    const result = calculateCapacity({
      plannedEffort: { BACKEND: 100 },
      team: team([line({ role: 'QA' })]),
      calendar: DEFAULT_CALENDAR,
      availableWorkingDays: 20,
    });

    for (const entry of result.byRole) {
      expect(Number.isFinite(entry.utilisation)).toBe(true);
    }
  });

  it('notices a capacity change that would alter what fits', () => {
    expect(isMaterialCapacityChange(team([line()]), team([line()]))).toBe(false);
    expect(isMaterialCapacityChange(team([line()]), team([line({ people: 3 })]))).toBe(true);
    expect(isMaterialCapacityChange({ supplied: false, lines: [] }, team([line()]))).toBe(true);
  });
});

describe('recommending a team', () => {
  it('keeps fractional roles fractional', () => {
    const staffing = recommendStaffing({
      plannedEffort: { BACKEND: 260, DEVOPS: 26 },
      calendar: DEFAULT_CALENDAR,
      availableWorkingDays: 20,
    });

    expect(staffing.find((line) => line.role === 'BACKEND')?.people).toBe(2);
    expect(staffing.find((line) => line.role === 'DEVOPS')?.people).toBe(0.2);
  });

  /* "0.2 DevOps engineers" reads as an error unless it is explained. */
  it('explains what a fraction of a person means in days a week', () => {
    const staffing = recommendStaffing({
      plannedEffort: { DEVOPS: 26 },
      calendar: DEFAULT_CALENDAR,
      availableWorkingDays: 20,
    });

    expect(staffing[0]?.note).toMatch(/day.* a week/);
    expect(staffing[0]?.note).toContain('not a full-time person');
  });

  it('recommends nothing when the timeline cannot be measured', () => {
    expect(
      recommendStaffing({
        plannedEffort: { BACKEND: 100 },
        calendar: DEFAULT_CALENDAR,
        availableWorkingDays: null,
      }),
    ).toEqual([]);
  });

  it('computes people from hours, day length and days', () => {
    expect(peopleForHours(130, DEFAULT_CALENDAR, 20)).toBe(1);
    expect(peopleForHours(0, DEFAULT_CALENDAR, 20)).toBe(0);
    expect(peopleForHours(100, DEFAULT_CALENDAR, 0)).toBe(0);
  });
});

/* --------------------------------------------------------- dependencies */

describe('the dependency graph', () => {
  const dependency = (
    id: string,
    predecessorId: string,
    successorId: string,
    type: DependencyType = 'FINISH_TO_START',
  ): Dependency => ({
    id,
    predecessorId,
    successorId,
    type,
    reason: 'user_defined',
    lagDays: 0,
    userDefined: true,
  });

  it('accepts a straight chain', () => {
    const problems = validateDependencies({
      dependencies: [dependency('d1', 'a', 'b'), dependency('d2', 'b', 'c')],
      taskIds: ['a', 'b', 'c'],
      excludedTaskIds: [],
    });

    expect(problems).toEqual([]);
  });

  it('finds a two-task loop', () => {
    const problems = validateDependencies({
      dependencies: [dependency('d1', 'a', 'b'), dependency('d2', 'b', 'a')],
      taskIds: ['a', 'b'],
      excludedTaskIds: [],
    });

    const cycle = problems.find((problem) => problem.kind === 'cycle');

    expect(cycle?.blocking).toBe(true);
    expect(cycle?.ids).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('finds a longer loop', () => {
    const cycles = detectCycles({
      dependencies: [
        dependency('d1', 'a', 'b'),
        dependency('d2', 'b', 'c'),
        dependency('d3', 'c', 'a'),
      ],
      taskIds: ['a', 'b', 'c'],
      excludedTaskIds: [],
    });

    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(3);
  });

  /* One loop, one report — not once per entry point. */
  it('reports a loop once however many ways in there are', () => {
    const cycles = detectCycles({
      dependencies: [
        dependency('d1', 'a', 'b'),
        dependency('d2', 'b', 'a'),
        dependency('d3', 'c', 'a'),
      ],
      taskIds: ['a', 'b', 'c'],
      excludedTaskIds: [],
    });

    expect(cycles).toHaveLength(1);
  });

  it('rejects a task depending on itself', () => {
    const problems = validateDependencies({
      dependencies: [dependency('d1', 'a', 'a')],
      taskIds: ['a'],
      excludedTaskIds: [],
    });

    expect(problems[0]?.kind).toBe('self_reference');
    expect(problems[0]?.blocking).toBe(true);
  });

  it('reports an edge pointing at nothing', () => {
    const problems = validateDependencies({
      dependencies: [dependency('d1', 'a', 'ghost')],
      taskIds: ['a'],
      excludedTaskIds: [],
    });

    expect(problems.some((problem) => problem.kind === 'missing_successor')).toBe(true);
    expect(problems.every((problem) => !problem.blocking)).toBe(true);
  });

  /* Somebody removed a task and left the link — recoverable, not fatal. */
  it('separates an edge to a removed task from an edge to nothing', () => {
    const problems = validateDependencies({
      dependencies: [dependency('d1', 'a', 'b')],
      taskIds: ['a', 'b'],
      excludedTaskIds: ['b'],
    });

    expect(problems[0]?.kind).toBe('excluded_task');
    expect(problems[0]?.blocking).toBe(false);
  });

  it('notices the same dependency recorded twice', () => {
    const problems = validateDependencies({
      dependencies: [dependency('d1', 'a', 'b'), dependency('d2', 'a', 'b')],
      taskIds: ['a', 'b'],
      excludedTaskIds: [],
    });

    expect(problems.some((problem) => problem.kind === 'duplicate')).toBe(true);
  });

  it('ignores a loop that only exists through an excluded task', () => {
    const cycles = detectCycles({
      dependencies: [dependency('d1', 'a', 'b'), dependency('d2', 'b', 'a')],
      taskIds: ['a', 'b'],
      excludedTaskIds: ['b'],
    });

    expect(cycles).toEqual([]);
  });
});

/* ---------------------------------------------------------- scheduling */

describe('the schedule', () => {
  const calendar = DEFAULT_CALENDAR;
  const task = (id: string, role: string, hours: number) => ({ id, role, hours });
  const dependency = (
    id: string,
    predecessorId: string,
    successorId: string,
    type: DependencyType = 'FINISH_TO_START',
    lagDays = 0,
  ): Dependency => ({
    id,
    predecessorId,
    successorId,
    type,
    reason: 'user_defined',
    lagDays,
    userDefined: true,
  });

  it('turns hours into working days at the calendar day length', () => {
    expect(durationFor(6.5, calendar)).toBe(1);
    expect(durationFor(13, calendar)).toBe(2);
    expect(durationFor(14, calendar)).toBe(3);
    expect(durationFor(0, calendar)).toBe(1);
  });

  /*
   * The equation the specification forbids. 320 hours does not become 8 weeks
   * on its own — it depends entirely on how many people and what waits for what.
   */
  it('does not turn hours into duration without a team and a graph', () => {
    const solo = buildSchedule({
      tasks: [task('a', 'BACKEND', 130), task('b', 'BACKEND', 130)],
      dependencies: [],
      calendar,
      peoplePerRole: { BACKEND: 1 },
      allowParallel: true,
    });

    const pair = buildSchedule({
      tasks: [task('a', 'BACKEND', 130), task('b', 'BACKEND', 130)],
      dependencies: [],
      calendar,
      peoplePerRole: { BACKEND: 2 },
      allowParallel: true,
    });

    expect(solo.totalWorkingDays).toBe(40);
    expect(pair.totalWorkingDays).toBe(20);
  });

  it('runs independent tasks in different roles at once', () => {
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 65), task('b', 'FRONTEND', 65)],
      dependencies: [],
      calendar,
      peoplePerRole: { BACKEND: 1, FRONTEND: 1 },
      allowParallel: true,
    });

    expect(schedule.totalWorkingDays).toBe(10);
    expect(schedule.tasks.every((entry) => entry.startDay === 1)).toBe(true);
  });

  /* One engineer cannot do two things at once, however independent they are. */
  it('serialises two tasks contending for one person', () => {
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 65), task('b', 'BACKEND', 65)],
      dependencies: [],
      calendar,
      peoplePerRole: { BACKEND: 1 },
      allowParallel: true,
    });

    const [first, second] = schedule.tasks;

    expect(second!.startDay).toBe(first!.endDay + 1);
  });

  it('honours a finish-to-start dependency', () => {
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 65), task('b', 'FRONTEND', 65)],
      dependencies: [dependency('d1', 'a', 'b')],
      calendar,
      peoplePerRole: { BACKEND: 1, FRONTEND: 1 },
      allowParallel: true,
    });

    const a = schedule.tasks.find((entry) => entry.taskId === 'a')!;
    const b = schedule.tasks.find((entry) => entry.taskId === 'b')!;

    expect(b.startDay).toBe(a.endDay + 1);
  });

  it('honours a start-to-start dependency', () => {
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 130), task('b', 'FRONTEND', 65)],
      dependencies: [dependency('d1', 'a', 'b', 'START_TO_START')],
      calendar,
      peoplePerRole: { BACKEND: 1, FRONTEND: 1 },
      allowParallel: true,
    });

    const a = schedule.tasks.find((entry) => entry.taskId === 'a')!;
    const b = schedule.tasks.find((entry) => entry.taskId === 'b')!;

    expect(b.startDay).toBe(a.startDay);
  });

  it('honours a lag', () => {
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 65), task('b', 'FRONTEND', 65)],
      dependencies: [dependency('d1', 'a', 'b', 'FINISH_TO_START', 5)],
      calendar,
      peoplePerRole: { BACKEND: 1, FRONTEND: 1 },
      allowParallel: true,
    });

    const a = schedule.tasks.find((entry) => entry.taskId === 'a')!;
    const b = schedule.tasks.find((entry) => entry.taskId === 'b')!;

    expect(b.startDay).toBe(a.endDay + 1 + 5);
  });

  it('serialises everything when parallel work is forbidden', () => {
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 65), task('b', 'FRONTEND', 65)],
      dependencies: [],
      calendar,
      peoplePerRole: { BACKEND: 5, FRONTEND: 5 },
      allowParallel: false,
    });

    // Each role still has one slot, so the two roles run concurrently — what
    // `allowParallel: false` forbids is stacking people within a role.
    expect(schedule.tasks.every((entry) => entry.durationDays === 10)).toBe(true);
  });

  it('marks the zero-slack chain as the critical path', () => {
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 65), task('b', 'BACKEND', 65), task('c', 'QA', 6.5)],
      dependencies: [dependency('d1', 'a', 'b')],
      calendar,
      peoplePerRole: { BACKEND: 2, QA: 1 },
      allowParallel: true,
    });

    expect(schedule.criticalPath).toEqual(['a', 'b']);
  });

  it('gives a task that could slip some slack', () => {
    const schedule = buildSchedule({
      tasks: [task('long', 'BACKEND', 130), task('short', 'QA', 6.5)],
      dependencies: [],
      calendar,
      peoplePerRole: { BACKEND: 1, QA: 1 },
      allowParallel: true,
    });

    const short = schedule.tasks.find((entry) => entry.taskId === 'short')!;

    expect(short.slackDays).toBeGreaterThan(0);
    expect(short.onCriticalPath).toBe(false);
  });

  /* Same input, same dates. A schedule that drifts is not a plan. */
  it('is deterministic', () => {
    const input = {
      tasks: [task('a', 'BACKEND', 65), task('b', 'BACKEND', 30), task('c', 'QA', 20)],
      dependencies: [dependency('d1', 'a', 'c')],
      calendar,
      peoplePerRole: { BACKEND: 2, QA: 1 },
      allowParallel: true,
    };

    expect(buildSchedule(input)).toEqual(buildSchedule(input));
  });

  it('orders tasks so every predecessor comes first', () => {
    const order = topologicalOrder(
      [task('c', 'QA', 1), task('a', 'BACKEND', 1), task('b', 'BACKEND', 1)],
      [dependency('d1', 'a', 'b'), dependency('d2', 'b', 'c')],
    );

    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  /* No start date means relative days, and no invented calendar. */
  it('produces relative days when there is no start date', () => {
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 65)],
      dependencies: [],
      calendar,
      peoplePerRole: { BACKEND: 1 },
      allowParallel: true,
    });

    expect(schedule.relativeOnly).toBe(true);
    expect(schedule.startDate).toBeUndefined();
    expect(schedule.tasks[0]?.startDate).toBeUndefined();
    expect(schedule.tasks[0]?.startDay).toBe(1);
  });

  it('produces real dates when there is a start date', () => {
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 65)],
      dependencies: [],
      calendar,
      peoplePerRole: { BACKEND: 1 },
      allowParallel: true,
      startDate: '2026-08-10',
    });

    expect(schedule.relativeOnly).toBe(false);
    expect(schedule.startDate).toBe('2026-08-10');
    expect(schedule.tasks[0]?.startDate).toBe('2026-08-10');
    // Ten working days from Monday 10 August is Friday 21 August.
    expect(schedule.tasks[0]?.endDate).toBe('2026-08-21');
  });

  /*
   * The rule that makes "change the date, keep the effort" possible: the whole
   * computation is in working-day offsets, and the date is applied at the end.
   */
  it('changes only the dates when the start date moves', () => {
    const input = {
      tasks: [task('a', 'BACKEND', 65), task('b', 'QA', 20)],
      dependencies: [dependency('d1', 'a', 'b')],
      calendar,
      peoplePerRole: { BACKEND: 1, QA: 1 },
      allowParallel: true,
    };

    const august = buildSchedule({ ...input, startDate: '2026-08-10' });
    const september = buildSchedule({ ...input, startDate: '2026-09-14' });

    expect(september.totalWorkingDays).toBe(august.totalWorkingDays);
    expect(september.criticalPath).toEqual(august.criticalPath);
    expect(september.tasks.map((entry) => entry.startDay)).toEqual(
      august.tasks.map((entry) => entry.startDay),
    );
    expect(september.tasks.map((entry) => entry.hours)).toEqual(
      august.tasks.map((entry) => entry.hours),
    );
    expect(september.startDate).not.toBe(august.startDate);
  });

  it('starts on the next working day when the start date is a weekend', () => {
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 6.5)],
      dependencies: [],
      calendar,
      peoplePerRole: { BACKEND: 1 },
      allowParallel: true,
      startDate: '2026-08-08',
    });

    expect(schedule.startDate).toBe('2026-08-10');
  });

  it('skips holidays when it lays dates out', () => {
    const withHoliday: WorkingCalendar = { ...calendar, holidays: ['2026-08-12'] };
    const schedule = buildSchedule({
      tasks: [task('a', 'BACKEND', 26)],
      dependencies: [],
      calendar: withHoliday,
      peoplePerRole: { BACKEND: 1 },
      allowParallel: true,
      startDate: '2026-08-10',
    });

    // Four working days from Monday, with Wednesday a holiday, ends Friday.
    expect(schedule.tasks[0]?.endDate).toBe('2026-08-14');
  });
});

/* -------------------------------------------------------- feasibility */

describe('feasibility', () => {
  const capacity = (
    overrides: Partial<Parameters<typeof assessFeasibility>[0]['capacity']> = {},
  ) => ({
    byRole: [],
    totalPlannedHours: 400,
    totalAvailableHours: 520,
    totalGapHours: 0,
    capacityUnknown: false,
    overloadedRoles: [],
    ...overrides,
  });

  const input = (overrides: Partial<Parameters<typeof assessFeasibility>[0]> = {}) => ({
    requiredWorkingDays: 30,
    availableWorkingDays: 40,
    capacity: capacity(),
    highUncertaintyShare: 0,
    criticalPathDays: 20,
    hasUnassessedCodebase: false,
    hasExternalDependency: false,
    clientReviewBudgeted: true,
    allowParallel: true,
    ...overrides,
  });

  it('is comfortable with real headroom', () => {
    expect(assessFeasibility(input()).status).toBe('COMFORTABLE');
  });

  it('is achievable when it fits with modest headroom', () => {
    expect(assessFeasibility(input({ requiredWorkingDays: 34 })).status).toBe('FEASIBLE');
  });

  it('is tight when it barely fits', () => {
    expect(assessFeasibility(input({ requiredWorkingDays: 38 })).status).toBe('AGGRESSIVE');
  });

  /* The example from the specification, worked through. */
  it('reports a capacity shortfall rather than moving the deadline', () => {
    const result = assessFeasibility(
      input({
        capacity: capacity({
          totalPlannedHours: 1_250,
          totalAvailableHours: 760,
          totalGapHours: 490,
        }),
      }),
    );

    expect(result.status).toBe('NOT_FEASIBLE_WITH_CURRENT_CAPACITY');
    expect(result.capacityGapHours).toBe(490);
    expect(result.availableWorkingDays).toBe(40);
    expect(result.reason).toContain('490 hours short');
    expect(result.risks.some((risk) => risk.kind === 'insufficient_capacity')).toBe(true);
  });

  /* Enough hours, wrong shape — adding people does not shorten a chain. */
  it('is high risk when the hours fit but the sequence does not', () => {
    const result = assessFeasibility(input({ requiredWorkingDays: 60, availableWorkingDays: 40 }));

    expect(result.status).toBe('HIGH_RISK');
    expect(result.scheduleGapDays).toBe(20);
    expect(result.reason).toContain('cannot be shortened by adding people');
  });

  it('says capacity is unknown rather than guessing', () => {
    const result = assessFeasibility(
      input({
        capacity: capacity({ capacityUnknown: true, totalAvailableHours: 0, totalGapHours: 400 }),
      }),
    );

    expect(result.status).toBe('CAPACITY_UNKNOWN');
    expect(result.reason).toContain('Tell us who is on the team');
  });

  it('says it needs a start date rather than inventing one', () => {
    expect(assessFeasibility(input({ availableWorkingDays: null })).status).toBe(
      'TIMELINE_UNMEASURABLE',
    );
  });

  /*
   * A fixed deadline with no start date. The deadline is real; the span is not
   * yet, and the difference has to survive into the verdict.
   */
  describe('a fixed deadline with no start date', () => {
    const unmeasurable = () =>
      assessFeasibility(
        input({
          availableWorkingDays: null,
          capacity: capacity({ totalAvailableHours: 0, totalGapHours: 400 }),
        }),
      );

    it('is reported as conditional rather than as a verdict', () => {
      const result = unmeasurable();

      expect(result.determinacy).toBe('CONDITIONAL');
      expect(result.status).toBe('TIMELINE_UNMEASURABLE');
      expect(result.reason).toContain('kept exactly as you set it');
    });

    it('names the start date as the missing information', () => {
      expect(unmeasurable().missingInformation.map((missing) => missing.kind)).toEqual([
        'concrete_start_date',
      ]);
    });

    it('invents no available capacity between an unknown start and the deadline', () => {
      const result = unmeasurable();

      expect(result.availableWorkingDays).toBeNull();
      expect(result.availableHours).toBe(0);
      // Not a 400-hour shortfall. There is no span to be short against.
      expect(result.capacityGapHours).toBe(0);
      expect(result.scheduleGapDays).toBe(0);
    });

    it('raises no capacity or schedule risk it cannot measure', () => {
      const result = assessFeasibility(
        input({
          availableWorkingDays: null,
          capacity: capacity({
            totalAvailableHours: 0,
            totalGapHours: 400,
            overloadedRoles: ['BACKEND'],
          }),
        }),
      );

      const kinds = result.risks.map((risk) => risk.kind);
      expect(kinds).not.toContain('insufficient_capacity');
      expect(kinds).not.toContain('role_overloaded');
      expect(kinds).not.toContain('schedule_exceeds_timeline');
    });

    it('still reports the risks that come from the work itself', () => {
      const result = assessFeasibility(
        input({
          availableWorkingDays: null,
          highUncertaintyShare: 0.4,
          hasUnassessedCodebase: true,
        }),
      );

      const kinds = result.risks.map((risk) => risk.kind);
      expect(kinds).toContain('high_uncertainty_share');
      expect(kinds).toContain('unassessed_codebase');
    });

    it('keeps the working duration it calculated', () => {
      // The effort and the sequenced duration do not depend on a start date, so
      // an unknown start does not degrade them.
      expect(unmeasurable().requiredWorkingDays).toBe(30);
    });

    it('lists the team as missing too when nobody has said who is working', () => {
      const result = assessFeasibility(
        input({
          availableWorkingDays: null,
          capacity: capacity({ capacityUnknown: true, totalAvailableHours: 0 }),
        }),
      );

      expect(result.missingInformation.map((missing) => missing.kind)).toEqual([
        'concrete_start_date',
        'team_capacity',
      ]);
    });
  });

  it('marks an unknown team as conditional rather than assessed', () => {
    const result = assessFeasibility(
      input({ capacity: capacity({ capacityUnknown: true, totalAvailableHours: 0 }) }),
    );

    expect(result.determinacy).toBe('CONDITIONAL');
    expect(result.missingInformation.map((missing) => missing.kind)).toEqual(['team_capacity']);
  });

  it('reports a measurable verdict as determined, with nothing missing', () => {
    const result = assessFeasibility(input());

    expect(result.determinacy).toBe('DETERMINED');
    expect(result.missingInformation).toEqual([]);
  });

  it('is tight when a role is loaded past sustainability', () => {
    expect(
      assessFeasibility(input({ capacity: capacity({ overloadedRoles: ['BACKEND'] }) })).status,
    ).toBe('AGGRESSIVE');
  });

  /* Reported as an unknown, never absorbed as invented client delay. */
  it('raises unbudgeted client review as a risk rather than padding for it', () => {
    const result = assessFeasibility(input({ clientReviewBudgeted: false }));

    expect(result.risks.some((risk) => risk.kind === 'client_review_unbudgeted')).toBe(true);
    expect(result.requiredWorkingDays).toBe(30);
  });

  it('raises an unassessed codebase as a risk', () => {
    expect(
      assessFeasibility(input({ hasUnassessedCodebase: true })).risks.some(
        (risk) => risk.kind === 'unassessed_codebase',
      ),
    ).toBe(true);
  });

  it('raises a large share of unknown work as a risk', () => {
    expect(
      assessFeasibility(input({ highUncertaintyShare: 0.4 })).risks.some(
        (risk) => risk.kind === 'high_uncertainty_share',
      ),
    ).toBe(true);
  });

  it('never alters the available days it was given', () => {
    for (const days of [10, 40, 400]) {
      expect(assessFeasibility(input({ availableWorkingDays: days })).availableWorkingDays).toBe(
        days,
      );
    }
  });

  it('requires acknowledgement only where the timeline is at risk', () => {
    expect(feasibilityNeedsAcknowledgement('COMFORTABLE')).toBe(false);
    expect(feasibilityNeedsAcknowledgement('FEASIBLE')).toBe(false);
    expect(feasibilityNeedsAcknowledgement('AGGRESSIVE')).toBe(true);
    expect(feasibilityNeedsAcknowledgement('HIGH_RISK')).toBe(true);
    expect(feasibilityNeedsAcknowledgement('NOT_FEASIBLE_WITH_CURRENT_CAPACITY')).toBe(true);
  });
});

/* ---------------------------------------------------------- overrides */

describe('override authority', () => {
  it('treats only a person’s figure as theirs', () => {
    expect(isUserAuthored('USER_OVERRIDE')).toBe(true);
    expect(isUserAuthored('AI_PROPOSED')).toBe(false);
    expect(isUserAuthored('AI_REESTIMATE')).toBe(false);
    expect(isUserAuthored('SYSTEM_CALCULATED')).toBe(false);
    expect(isUserAuthored('SYSTEM_RECALCULATION')).toBe(false);
  });
});
