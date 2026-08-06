import { describe, expect, it } from 'vitest';

import { SECURITY_HEADERS } from './security-headers';

const byKey = new Map(SECURITY_HEADERS.map((header) => [header.key, header.value]));

describe('SECURITY_HEADERS', () => {
  it.each([
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['X-DNS-Prefetch-Control', 'off'],
  ])('sends %s: %s', (key, value) => {
    expect(byKey.get(key)).toBe(value);
  });

  it('denies the capabilities the workspace never needs', () => {
    const permissions = byKey.get('Permissions-Policy');

    expect(permissions).toBeDefined();
    for (const feature of ['camera=()', 'microphone=()', 'geolocation=()']) {
      expect(permissions).toContain(feature);
    }
  });

  it('declares no Content-Security-Policy — deferred to Phase 12', () => {
    // This asserts the *documented current state*, not a desired end state. When
    // the CSP lands, this test is replaced by one asserting its directives.
    expect(byKey.has('Content-Security-Policy')).toBe(false);
    expect(byKey.has('Content-Security-Policy-Report-Only')).toBe(false);
  });

  it('has no duplicate header keys', () => {
    expect(byKey.size).toBe(SECURITY_HEADERS.length);
  });

  it('has a non-empty value for every header', () => {
    for (const header of SECURITY_HEADERS) {
      expect(header.value.trim().length).toBeGreaterThan(0);
    }
  });
});
