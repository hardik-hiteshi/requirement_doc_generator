import { describe, expect, it } from 'vitest';

import {
  ALLOWED_FORMATS,
  outputPreferencesSchema,
  PROJECT_DOCUMENTS,
} from './output-preferences.contract';
import {
  buildRecoveryLink,
  isProjectId,
  isRecoverySecret,
  parseRecoveryFragment,
} from './project-identifiers';
import { canTransition, isDeleted, isMutable, PROJECT_STATUSES } from './project-status';
import { MAX_PROJECT_TYPES, projectTypeSelectionSchema } from './project-type.contract';
import {
  startDateSchema,
  supportsCalendarScheduling,
  validateDeadlineAgainstStart,
} from './start-date.contract';
import { customRoleKey, teamCapacitySchema } from './team-capacity.contract';
import { timelineSchema, validateDeadlineAgainst } from './timeline.contract';

const NOW = new Date('2026-08-06T12:00:00.000Z');

describe('recovery links', () => {
  const projectId = 'prj_0123456789ABCDEFGHJKMNPQRS';
  const secret = 'a'.repeat(43);

  it('round-trips through the fragment', () => {
    const link = buildRecoveryLink('https://app.test', projectId, secret);
    expect(parseRecoveryFragment(link.split('#')[1] ?? '')).toEqual({
      projectId,
      recoverySecret: secret,
    });
  });

  it('puts the secret after the # so it never reaches a server log', () => {
    const link = buildRecoveryLink('https://app.test', projectId, secret);
    const [beforeHash] = link.split('#');

    expect(beforeHash).not.toContain(secret);
    expect(link).toContain('#');
  });

  it('strips a trailing slash from the base URL', () => {
    expect(buildRecoveryLink('https://app.test///', projectId, secret)).toContain(
      'https://app.test/recover#',
    );
  });

  it.each(['', 'p=nope&s=nope', 'p=prj_0123456789ABCDEFGHJKMNPQRS', 'garbage'])(
    'rejects malformed fragment %p',
    (fragment) => {
      expect(parseRecoveryFragment(fragment)).toBeNull();
    },
  );

  it('validates identifier shapes', () => {
    expect(isProjectId(projectId)).toBe(true);
    expect(isProjectId('prj_short')).toBe(false);
    // I, L, O and U are excluded from the alphabet.
    expect(isProjectId('prj_IIIIIIIIIIIIIIIIIIIIIIIIII')).toBe(false);
    expect(isRecoverySecret(secret)).toBe(true);
    expect(isRecoverySecret('too-short')).toBe(false);
  });
});

describe('project status transitions', () => {
  it('never allows a deleted project back to life', () => {
    for (const status of PROJECT_STATUSES) {
      if (status !== 'DELETED') {
        expect(canTransition('DELETED', status)).toBe(false);
      }
    }
  });

  it('treats both deletion states as gone', () => {
    expect(isDeleted('DELETION_PENDING')).toBe(true);
    expect(isDeleted('DELETED')).toBe(true);
    expect(isDeleted('EXPIRED')).toBe(false);
  });

  it('allows edits only while draft or active', () => {
    expect(isMutable('DRAFT')).toBe(true);
    expect(isMutable('ACTIVE')).toBe(true);
    expect(isMutable('EXPIRED')).toBe(false);
    expect(isMutable('DELETION_PENDING')).toBe(false);
  });
});

describe('timeline', () => {
  it.each([
    { mode: 'WORKING_DAYS', workingDays: 30 },
    { mode: 'WEEKS', weeks: 12 },
    { mode: 'MONTHS', months: 6 },
    { mode: 'FIXED_DEADLINE', deadline: '2026-12-01' },
  ])('accepts %o', (timeline) => {
    expect(timelineSchema.safeParse(timeline).success).toBe(true);
  });

  it('rejects a non-positive duration', () => {
    expect(timelineSchema.safeParse({ mode: 'WEEKS', weeks: 0 }).success).toBe(false);
    expect(timelineSchema.safeParse({ mode: 'MONTHS', months: -1 }).success).toBe(false);
  });

  it('rejects a duration beyond the configured limit', () => {
    expect(timelineSchema.safeParse({ mode: 'MONTHS', months: 600 }).success).toBe(false);
  });

  it('rejects an unknown mode', () => {
    expect(timelineSchema.safeParse({ mode: 'QUARTERS', quarters: 2 }).success).toBe(false);
  });

  it('makes two modes at once unrepresentable', () => {
    const result = timelineSchema.safeParse({ mode: 'WEEKS', weeks: 4, deadline: '2026-12-01' });
    // The discriminated union parses to the WEEKS branch and drops the rest.
    expect(result.success && 'deadline' in result.data).toBe(false);
  });

  it('rejects a date that looks valid but does not exist', () => {
    expect(
      timelineSchema.safeParse({ mode: 'FIXED_DEADLINE', deadline: '2026-02-31' }).success,
    ).toBe(false);
  });

  it('rejects a deadline in the past, against a supplied reference date', () => {
    const result = validateDeadlineAgainst({ mode: 'FIXED_DEADLINE', deadline: '2020-01-01' }, NOW);
    expect(result.valid).toBe(false);
  });

  it('accepts today as a deadline', () => {
    expect(
      validateDeadlineAgainst({ mode: 'FIXED_DEADLINE', deadline: '2026-08-06' }, NOW).valid,
    ).toBe(true);
  });

  it('rejects a deadline absurdly far ahead', () => {
    expect(
      validateDeadlineAgainst({ mode: 'FIXED_DEADLINE', deadline: '2999-01-01' }, NOW).valid,
    ).toBe(false);
  });
});

describe('start date', () => {
  it('needs no date for the undated modes', () => {
    expect(startDateSchema.safeParse({ mode: 'NOT_CONFIRMED' }).success).toBe(true);
    expect(startDateSchema.safeParse({ mode: 'IMMEDIATELY_AFTER_APPROVAL' }).success).toBe(true);
  });

  it('requires a date for the dated modes', () => {
    expect(startDateSchema.safeParse({ mode: 'CONFIRMED_DATE' }).success).toBe(false);
    expect(startDateSchema.safeParse({ mode: 'TENTATIVE_DATE' }).success).toBe(false);
    expect(startDateSchema.safeParse({ mode: 'CONFIRMED_DATE', date: '2026-09-01' }).success).toBe(
      true,
    );
  });

  it('reports calendar-scheduling capability honestly', () => {
    expect(supportsCalendarScheduling({ mode: 'NOT_CONFIRMED' })).toBe(false);
    expect(supportsCalendarScheduling({ mode: 'IMMEDIATELY_AFTER_APPROVAL' })).toBe(false);
    expect(supportsCalendarScheduling({ mode: 'TENTATIVE_DATE', date: '2026-09-01' })).toBe(true);
  });
});

describe('a deadline against a start date', () => {
  const deadline = { mode: 'FIXED_DEADLINE', deadline: '2026-11-30' } as const;

  it('refuses a deadline that falls before a concrete start', () => {
    for (const mode of ['CONFIRMED_DATE', 'TENTATIVE_DATE'] as const) {
      const result = validateDeadlineAgainstStart(deadline, { mode, date: '2027-01-15' });

      expect(result.valid).toBe(false);
      expect(result.valid ? '' : result.reason).toContain('2026-11-30');
    }
  });

  it('accepts a start on the deadline itself — one day is a span', () => {
    expect(
      validateDeadlineAgainstStart(deadline, { mode: 'CONFIRMED_DATE', date: '2026-11-30' }).valid,
    ).toBe(true);
  });

  it('accepts a start before the deadline', () => {
    expect(
      validateDeadlineAgainstStart(deadline, { mode: 'CONFIRMED_DATE', date: '2026-09-01' }).valid,
    ).toBe(true);
  });

  /* Incomplete is not the same as contradictory, and only one of them is an error. */
  it('says nothing about the undated modes', () => {
    expect(validateDeadlineAgainstStart(deadline, { mode: 'NOT_CONFIRMED' }).valid).toBe(true);
    expect(
      validateDeadlineAgainstStart(deadline, { mode: 'IMMEDIATELY_AFTER_APPROVAL' }).valid,
    ).toBe(true);
    expect(validateDeadlineAgainstStart(deadline, undefined).valid).toBe(true);
  });

  it('applies only to a fixed deadline', () => {
    expect(
      validateDeadlineAgainstStart(
        { mode: 'WEEKS' },
        { mode: 'CONFIRMED_DATE', date: '2030-01-01' },
      ).valid,
    ).toBe(true);
    expect(
      validateDeadlineAgainstStart(undefined, { mode: 'CONFIRMED_DATE', date: '2030-01-01' }).valid,
    ).toBe(true);
  });
});

describe('team capacity', () => {
  it('accepts an entirely empty capacity — it is optional', () => {
    expect(teamCapacitySchema.safeParse({}).success).toBe(true);
  });

  it('accepts a single role without requiring all nine', () => {
    expect(teamCapacitySchema.safeParse({ roles: { qaEngineer: 2 } }).success).toBe(true);
  });

  it('rejects a negative count', () => {
    expect(teamCapacitySchema.safeParse({ roles: { qaEngineer: -1 } }).success).toBe(false);
  });

  it('rejects negative durations', () => {
    expect(teamCapacitySchema.safeParse({ uatDays: -5 }).success).toBe(false);
  });

  it('normalises custom role names for comparison', () => {
    expect(customRoleKey('  QA   Lead ')).toBe('qa lead');
  });

  it('rejects duplicate custom roles that differ only in case or spacing', () => {
    const result = teamCapacitySchema.safeParse({
      customRoles: [
        { name: 'Data Engineer', count: 1 },
        { name: '  data   engineer ', count: 2 },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a custom role duplicating a standard one', () => {
    const result = teamCapacitySchema.safeParse({
      customRoles: [{ name: 'QA engineer', count: 1 }],
    });

    expect(result.success).toBe(false);
  });
});

describe('output preferences', () => {
  it('accepts a valid selection for one document', () => {
    expect(outputPreferencesSchema.safeParse({ OUR_UNDERSTANDING: ['DOCX'] }).success).toBe(true);
  });

  it('rejects a format the document does not support', () => {
    expect(outputPreferencesSchema.safeParse({ OUR_UNDERSTANDING: ['CSV'] }).success).toBe(false);
    expect(outputPreferencesSchema.safeParse({ ASSUMPTIONS: ['XLSX'] }).success).toBe(false);
  });

  it('rejects a duplicated format', () => {
    expect(outputPreferencesSchema.safeParse({ ASSUMPTIONS: ['PDF', 'PDF'] }).success).toBe(false);
  });

  it('rejects an empty selection', () => {
    expect(outputPreferencesSchema.safeParse({ ASSUMPTIONS: [] }).success).toBe(false);
  });

  it('accepts every documented format for every document', () => {
    for (const document of PROJECT_DOCUMENTS) {
      const result = outputPreferencesSchema.safeParse({
        [document]: [...ALLOWED_FORMATS[document]],
      });
      expect(result.success).toBe(true);
    }
  });
});

describe('project type', () => {
  it('accepts a multi-platform selection', () => {
    expect(
      projectTypeSelectionSchema.safeParse(['SAAS_PLATFORM', 'MOBILE_APPLICATION']).success,
    ).toBe(true);
  });

  it('rejects duplicates', () => {
    expect(projectTypeSelectionSchema.safeParse(['MIGRATION', 'MIGRATION']).success).toBe(false);
  });

  it('rejects an empty selection and one beyond the limit', () => {
    expect(projectTypeSelectionSchema.safeParse([]).success).toBe(false);
    expect(
      projectTypeSelectionSchema.safeParse(
        Array.from(
          { length: MAX_PROJECT_TYPES + 1 },
          (_, index) =>
            ['WEBSITE', 'WEB_APPLICATION', 'MIGRATION', 'MODERNISATION', 'BACKEND_API'][index],
        ),
      ).success,
    ).toBe(false);
  });
});
