import { PROJECT_STATUSES, canTransition, type ProjectStatus } from '@wdrg/contracts';

import type { ProjectRecord } from '../project.repository';
import {
  assertTransition,
  calculateExpiry,
  canRead,
  canWrite,
  daysUntilExpiry,
  effectiveStatus,
  statusAfterEdit,
} from './project-lifecycle';

const NOW = new Date('2026-08-06T12:00:00.000Z');

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    projectId: 'prj_0123456789ABCDEFGHJKMNPQRS',
    status: 'ACTIVE',
    version: 3,
    name: 'Acme portal',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-05T00:00:00.000Z'),
    lastAccessedAt: new Date('2026-08-05T00:00:00.000Z'),
    expiresAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('effectiveStatus', () => {
  it('returns the stored status while the project is live', () => {
    expect(effectiveStatus(project({ status: 'DRAFT' }), NOW)).toBe('DRAFT');
    expect(effectiveStatus(project({ status: 'ACTIVE' }), NOW)).toBe('ACTIVE');
  });

  it('derives EXPIRED once the expiry has passed, without a background job', () => {
    const expired = project({ expiresAt: new Date('2026-08-05T00:00:00.000Z') });
    expect(effectiveStatus(expired, NOW)).toBe('EXPIRED');
  });

  it('treats the exact expiry instant as expired', () => {
    expect(effectiveStatus(project({ expiresAt: NOW }), NOW)).toBe('EXPIRED');
  });

  it('keeps a deleted project deleted even after its expiry passes', () => {
    const deleted = project({
      status: 'DELETION_PENDING',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(effectiveStatus(deleted, NOW)).toBe('DELETION_PENDING');
  });
});

describe('canRead', () => {
  it.each<ProjectStatus>(['DRAFT', 'ACTIVE'])('allows reading a %s project', (status) => {
    expect(canRead(project({ status }), NOW)).toEqual({ allowed: true, status });
  });

  it('still allows reading an expired project so the user can copy their work out', () => {
    const expired = project({ expiresAt: new Date('2026-08-01T00:00:00.000Z') });
    expect(canRead(expired, NOW)).toEqual({ allowed: true, status: 'EXPIRED' });
  });

  it.each<ProjectStatus>(['DELETION_PENDING', 'DELETED'])('refuses a %s project', (status) => {
    expect(canRead(project({ status }), NOW)).toEqual({ allowed: false, reason: 'DELETED' });
  });
});

describe('canWrite', () => {
  it.each<ProjectStatus>(['DRAFT', 'ACTIVE'])('allows writing to a %s project', (status) => {
    expect(canWrite(project({ status }), NOW)).toEqual({ allowed: true, status });
  });

  it('refuses to write to an expired project', () => {
    const expired = project({ expiresAt: new Date('2026-08-01T00:00:00.000Z') });
    expect(canWrite(expired, NOW)).toEqual({ allowed: false, reason: 'EXPIRED' });
  });

  it.each<ProjectStatus>(['DELETION_PENDING', 'DELETED'])('refuses a %s project', (status) => {
    expect(canWrite(project({ status }), NOW)).toEqual({ allowed: false, reason: 'DELETED' });
  });
});

describe('statusAfterEdit', () => {
  it('promotes an untouched draft to active on first edit', () => {
    expect(statusAfterEdit('DRAFT')).toBe('ACTIVE');
  });

  it('leaves an active project active', () => {
    expect(statusAfterEdit('ACTIVE')).toBe('ACTIVE');
  });
});

describe('assertTransition', () => {
  it('permits a no-op transition', () => {
    expect(assertTransition('ACTIVE', 'ACTIVE').valid).toBe(true);
  });

  it.each([
    ['DRAFT', 'ACTIVE'],
    ['ACTIVE', 'EXPIRED'],
    ['EXPIRED', 'DELETION_PENDING'],
    ['DELETION_PENDING', 'DELETED'],
  ] as const)('permits %s -> %s', (from, to) => {
    expect(assertTransition(from, to).valid).toBe(true);
  });

  it.each([
    ['DELETED', 'ACTIVE'],
    ['DELETION_PENDING', 'ACTIVE'],
    ['EXPIRED', 'ACTIVE'],
    ['DELETED', 'DRAFT'],
  ] as const)('refuses %s -> %s', (from, to) => {
    const result = assertTransition(from, to);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain(from);
  });

  it('agrees with the shared transition table for every pair', () => {
    for (const from of PROJECT_STATUSES) {
      for (const to of PROJECT_STATUSES) {
        const expected = from === to || canTransition(from, to);
        expect(assertTransition(from, to).valid).toBe(expected);
      }
    }
  });

  it('makes DELETED terminal', () => {
    for (const to of PROJECT_STATUSES) {
      if (to !== 'DELETED') {
        expect(assertTransition('DELETED', to).valid).toBe(false);
      }
    }
  });
});

describe('expiry helpers', () => {
  it('calculates expiry from the configured retention window', () => {
    expect(calculateExpiry(NOW, 30).toISOString()).toBe('2026-09-05T12:00:00.000Z');
  });

  it('reports whole days remaining', () => {
    expect(daysUntilExpiry(project({ expiresAt: new Date('2026-08-09T12:00:00.000Z') }), NOW)).toBe(
      3,
    );
  });

  it('never reports negative days once expired', () => {
    expect(daysUntilExpiry(project({ expiresAt: new Date('2026-07-01T00:00:00.000Z') }), NOW)).toBe(
      0,
    );
  });
});
