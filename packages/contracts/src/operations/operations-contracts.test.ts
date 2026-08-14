import { describe, expect, it } from 'vitest';

import { ADMIN_TOKEN_MIN_LENGTH, adminAuditQuerySchema, adminStatusSchema } from './admin.contract';
import {
  METRIC_NAMES,
  escapeLabelValue,
  renderMetrics,
  type MetricSample,
} from './metrics.contract';
import {
  DEFAULT_RATE_LIMITS,
  RATE_LIMIT_CLASSES,
  isAddressKeyed,
  rateLimitKey,
  rateLimitPoliciesSchema,
} from './rate-limit.contract';
import {
  PRESERVED_COLLECTIONS,
  PURGEABLE_COLLECTIONS,
  isAbandoned,
  isPurgeEligible,
  retentionPolicySchema,
  type RetentionPolicy,
} from './retention.contract';

const policy: RetentionPolicy = {
  deletionGraceDays: 7,
  expiredGraceDays: 90,
  batchSize: 25,
};

const day = 24 * 60 * 60 * 1000;

describe('rate-limit policy', () => {
  it('has a budget for every class', () => {
    for (const rateClass of RATE_LIMIT_CLASSES) {
      expect(DEFAULT_RATE_LIMITS[rateClass].limit).toBeGreaterThan(0);
      expect(DEFAULT_RATE_LIMITS[rateClass].windowSeconds).toBeGreaterThan(0);
    }

    expect(rateLimitPoliciesSchema.safeParse(DEFAULT_RATE_LIMITS).success).toBe(true);
  });

  it('leaves the expensive classes tighter than ordinary reading', () => {
    /*
     * The whole reason for classifying: a model run must not be as freely repeatable
     * as reading a panel.
     */
    const perMinute = (name: keyof typeof DEFAULT_RATE_LIMITS) =>
      DEFAULT_RATE_LIMITS[name].limit / DEFAULT_RATE_LIMITS[name].windowSeconds;

    expect(perMinute('expensive')).toBeLessThan(perMinute('default'));
    expect(perMinute('export')).toBeLessThan(perMinute('default'));
    expect(perMinute('upload')).toBeLessThan(perMinute('default'));
    expect(perMinute('access')).toBeLessThan(perMinute('mutation'));
  });

  it('keys the pre-session classes by address and everything else by session', () => {
    /* Creating and recovering both happen before a session exists. */
    const preSession = ['access', 'create'] as const;

    for (const rateClass of preSession) {
      expect(isAddressKeyed(rateClass)).toBe(true);
    }

    for (const rateClass of RATE_LIMIT_CLASSES.filter(
      (entry) => !preSession.includes(entry as (typeof preSession)[number]),
    )) {
      expect(isAddressKeyed(rateClass)).toBe(false);
    }
  });

  it('keeps bulk creation off the credential-guessing budget', () => {
    /*
     * Two separate budgets, because they defend different things: guessing a recovery
     * secret attacks one project's confidentiality, and creating projects in bulk
     * attacks disk. Neither ceiling needs to dominate the other — what matters is that
     * spending one does not spend the other, so an agency starting a dozen projects is
     * never refused because of somebody else's failed recovery attempts.
     */
    const creating = rateLimitKey({
      rateClass: 'create',
      sessionId: undefined,
      address: '10.0.0.1',
    });
    const recovering = rateLimitKey({
      rateClass: 'access',
      sessionId: undefined,
      address: '10.0.0.1',
    });

    expect(creating).not.toBe(recovering);

    /* And creation allows a real working session's worth of projects in an hour. */
    const perHour =
      (DEFAULT_RATE_LIMITS.create.limit / DEFAULT_RATE_LIMITS.create.windowSeconds) * 3_600;

    expect(perHour).toBeGreaterThanOrEqual(20);
  });

  it('refuses a policy outside its bounds', () => {
    expect(
      rateLimitPoliciesSchema.safeParse({
        ...DEFAULT_RATE_LIMITS,
        default: { limit: 0, windowSeconds: 60 },
      }).success,
    ).toBe(false);
    expect(
      rateLimitPoliciesSchema.safeParse({
        ...DEFAULT_RATE_LIMITS,
        extra: { limit: 1, windowSeconds: 1 },
      }).success,
    ).toBe(false);
  });
});

describe('retention eligibility', () => {
  it('purges only from the pending state', () => {
    const requested = new Date('2026-01-01T00:00:00.000Z');
    const now = new Date(requested.getTime() + 30 * day);

    for (const status of ['DRAFT', 'ACTIVE', 'EXPIRED', 'DELETED'] as const) {
      expect(isPurgeEligible({ status, deletionRequestedAt: requested, now, policy })).toBe(false);
    }

    expect(
      isPurgeEligible({ status: 'DELETION_PENDING', deletionRequestedAt: requested, now, policy }),
    ).toBe(true);
  });

  it('waits out the grace window to the day', () => {
    const requested = new Date('2026-01-01T00:00:00.000Z');

    const atSixDays = new Date(requested.getTime() + 6 * day);
    const atSeven = new Date(requested.getTime() + 7 * day);

    expect(
      isPurgeEligible({
        status: 'DELETION_PENDING',
        deletionRequestedAt: requested,
        now: atSixDays,
        policy,
      }),
    ).toBe(false);
    expect(
      isPurgeEligible({
        status: 'DELETION_PENDING',
        deletionRequestedAt: requested,
        now: atSeven,
        policy,
      }),
    ).toBe(true);
  });

  it('waits rather than purging when the request has no timestamp', () => {
    /*
     * Missing data about a destructive operation reads as "wait". The alternative —
     * treating absence as infinitely old — would purge exactly the records whose
     * history is least well understood.
     */
    expect(
      isPurgeEligible({
        status: 'DELETION_PENDING',
        deletionRequestedAt: undefined,
        now: new Date('2030-01-01T00:00:00.000Z'),
        policy,
      }),
    ).toBe(false);
  });

  it('queues an expired project only once it has been abandoned', () => {
    const expiresAt = new Date('2026-01-01T00:00:00.000Z');

    expect(
      isAbandoned({
        status: 'EXPIRED',
        expiresAt,
        now: new Date(expiresAt.getTime() + 89 * day),
        policy,
      }),
    ).toBe(false);
    expect(
      isAbandoned({
        status: 'EXPIRED',
        expiresAt,
        now: new Date(expiresAt.getTime() + 90 * day),
        policy,
      }),
    ).toBe(true);
  });

  it('never treats a live project as abandoned', () => {
    const expiresAt = new Date('2020-01-01T00:00:00.000Z');

    for (const status of ['DRAFT', 'ACTIVE', 'DELETION_PENDING', 'DELETED'] as const) {
      expect(isAbandoned({ status, expiresAt, now: new Date(), policy })).toBe(false);
    }
  });

  it('refuses a policy that would purge without any grace at all in production terms', () => {
    expect(retentionPolicySchema.safeParse({ ...policy, expiredGraceDays: 0 }).success).toBe(false);
    expect(retentionPolicySchema.safeParse({ ...policy, batchSize: 0 }).success).toBe(false);
    /* Zero deletion grace parses — the production policy is what refuses it. */
    expect(retentionPolicySchema.safeParse({ ...policy, deletionGraceDays: 0 }).success).toBe(true);
  });
});

describe('the purgeable collection list', () => {
  it('never includes the record or the trail that account for a deletion', () => {
    for (const preserved of PRESERVED_COLLECTIONS) {
      expect(PURGEABLE_COLLECTIONS).not.toContain(preserved);
    }
  });

  it('lists each collection once', () => {
    expect(new Set(PURGEABLE_COLLECTIONS).size).toBe(PURGEABLE_COLLECTIONS.length);
  });
});

describe('metric rendering', () => {
  it('emits help and type once per metric, before its samples', () => {
    const samples: MetricSample[] = [
      { name: METRIC_NAMES.rateLimitRefusalsTotal, labels: { class: 'export' }, value: 2 },
      { name: METRIC_NAMES.rateLimitRefusalsTotal, labels: { class: 'upload' }, value: 1 },
    ];

    const text = renderMetrics(samples);
    const lines = text.trim().split('\n');

    expect(lines[0]).toContain('# HELP wdrg_rate_limit_refusals_total');
    expect(lines[1]).toBe('# TYPE wdrg_rate_limit_refusals_total counter');
    expect(lines[2]).toBe('wdrg_rate_limit_refusals_total{class="export"} 2');
    expect(lines[3]).toBe('wdrg_rate_limit_refusals_total{class="upload"} 1');
    /* A repeated TYPE line makes a collector reject the whole scrape. */
    expect(text.match(/# TYPE wdrg_rate_limit_refusals_total/g)).toHaveLength(1);
  });

  it('writes a metric with no labels bare', () => {
    const text = renderMetrics([
      { name: METRIC_NAMES.retentionProjectsPurgedTotal, labels: {}, value: 4 },
    ]);

    expect(text).toContain('wdrg_retention_projects_purged_total 4');
  });

  it('escapes what the format treats specially', () => {
    expect(escapeLabelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });

  it('ends with a newline, which some collectors need to accept the last sample', () => {
    expect(renderMetrics([{ name: METRIC_NAMES.exportsTotal, labels: {}, value: 1 }])).toMatch(
      /\n$/,
    );
  });
});

describe('the operator contract', () => {
  it('requires a token long enough not to be guessed', () => {
    expect(ADMIN_TOKEN_MIN_LENGTH).toBeGreaterThanOrEqual(32);
  });

  it('defaults the audit page size and caps it', () => {
    expect(adminAuditQuerySchema.parse({}).limit).toBe(50);
    expect(adminAuditQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
  });

  it('rejects an unknown filter rather than ignoring it', () => {
    expect(adminAuditQuerySchema.safeParse({ contains: 'secret' }).success).toBe(false);
  });

  it('accepts a status payload and refuses an unknown field', () => {
    const status = {
      observedAt: '2026-08-14T00:00:00.000Z',
      version: '0.1.0',
      environment: 'production',
      projects: { DRAFT: 1, ACTIVE: 2, EXPIRED: 0, DELETION_PENDING: 0, DELETED: 3 },
      retention: {
        enabled: true,
        deletionGraceDays: 7,
        expiredGraceDays: 90,
        pendingDeletion: 0,
      },
      rateLimit: { enabled: true, trackedKeys: 4, refusals: { export: 1 } },
      storage: { adapter: 's3', malwareScanner: 'clamav' },
    };

    expect(adminStatusSchema.safeParse(status).success).toBe(true);
    expect(adminStatusSchema.safeParse({ ...status, secret: 'x' }).success).toBe(false);
  });
});
