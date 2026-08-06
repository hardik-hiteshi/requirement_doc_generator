import { CSRF_COOKIE, PROJECT_SESSION_COOKIE } from '@wdrg/contracts';
import type { Request, Response } from 'express';

import type { AppConfigService } from '../config/app-config.service';
import { ProjectSessionService } from './project-session.service';

const PROJECT_ID = 'prj_0123456789ABCDEFGHJKMNPQRS';

function config(overrides: { isProduction?: boolean; ttlSeconds?: number } = {}): AppConfigService {
  return {
    isProduction: overrides.isProduction ?? false,
    session: {
      secret: 'unit-test-session-secret-value-0000000000',
      ttlSeconds: overrides.ttlSeconds ?? 3_600,
    },
    // Partial stub: only what ProjectSessionService reads.
  } as unknown as AppConfigService;
}

interface CapturedCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

function createResponse() {
  const cookies: CapturedCookie[] = [];
  const response = {
    cookie(name: string, value: string, options: Record<string, unknown>) {
      cookies.push({ name, value, options });
      return this;
    },
  } as unknown as Response;

  return { response, cookies };
}

function requestWith(cookies: Record<string, string>, headers: Record<string, string> = {}) {
  return {
    cookies,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

describe('ProjectSessionService', () => {
  describe('issue', () => {
    it('sets a session cookie and a CSRF cookie', () => {
      const { response, cookies } = createResponse();
      new ProjectSessionService(config()).issue(response, PROJECT_ID);

      expect(cookies.map((cookie) => cookie.name)).toEqual([PROJECT_SESSION_COOKIE, CSRF_COOKIE]);
    });

    it('makes the session cookie HttpOnly so script cannot read it', () => {
      const { response, cookies } = createResponse();
      new ProjectSessionService(config()).issue(response, PROJECT_ID);

      expect(cookies[0]?.options.httpOnly).toBe(true);
    });

    it('leaves the CSRF cookie readable, which is what makes double-submit work', () => {
      const { response, cookies } = createResponse();
      new ProjectSessionService(config()).issue(response, PROJECT_ID);

      expect(cookies[1]?.options.httpOnly).toBe(false);
    });

    it('marks cookies Secure in production', () => {
      const { response, cookies } = createResponse();
      new ProjectSessionService(config({ isProduction: true })).issue(response, PROJECT_ID);

      expect(cookies.every((cookie) => cookie.options.secure === true)).toBe(true);
    });

    it('does not require Secure in development, so localhost over http works', () => {
      const { response, cookies } = createResponse();
      new ProjectSessionService(config({ isProduction: false })).issue(response, PROJECT_ID);

      expect(cookies.every((cookie) => cookie.options.secure === false)).toBe(true);
    });

    it('uses SameSite=lax so a saved recovery link still carries the cookie', () => {
      const { response, cookies } = createResponse();
      new ProjectSessionService(config()).issue(response, PROJECT_ID);

      expect(cookies.every((cookie) => cookie.options.sameSite === 'lax')).toBe(true);
    });

    it('never puts the project id in the cookie in readable form', () => {
      const { response, cookies } = createResponse();
      new ProjectSessionService(config()).issue(response, PROJECT_ID);

      // Encoded, not encrypted — but it must at least not be plainly greppable.
      expect(cookies[0]?.value).not.toContain(PROJECT_ID);
    });
  });

  describe('verify', () => {
    it('round-trips a freshly issued session', () => {
      const service = new ProjectSessionService(config());
      const { response, cookies } = createResponse();
      service.issue(response, PROJECT_ID);

      const result = service.verify(requestWith({ [PROJECT_SESSION_COOKIE]: cookies[0]!.value }));

      expect(result.ok).toBe(true);
      expect(result.ok && result.session.projectId).toBe(PROJECT_ID);
    });

    it('reports an absent cookie', () => {
      const result = new ProjectSessionService(config()).verify(requestWith({}));
      expect(result).toEqual({ ok: false, failure: 'ABSENT' });
    });

    it('rejects a tampered payload', () => {
      const service = new ProjectSessionService(config());
      const { response, cookies } = createResponse();
      service.issue(response, PROJECT_ID);

      const [, signature] = cookies[0]!.value.split('.');
      const forged = Buffer.from(
        JSON.stringify({
          projectId: 'prj_ZZZZZZZZZZZZZZZZZZZZZZZZZZ',
          issuedAt: 0,
          expiresAt: 9_999_999_999,
        }),
        'utf8',
      ).toString('base64url');

      const result = service.verify(
        requestWith({ [PROJECT_SESSION_COOKIE]: `${forged}.${signature}` }),
      );

      expect(result).toEqual({ ok: false, failure: 'BAD_SIGNATURE' });
    });

    it('rejects a cookie signed with a different secret', () => {
      const { response, cookies } = createResponse();
      new ProjectSessionService(config()).issue(response, PROJECT_ID);

      const otherService = new ProjectSessionService({
        isProduction: false,
        session: { secret: 'a-completely-different-secret-0000000000', ttlSeconds: 3_600 },
      } as unknown as AppConfigService);

      expect(
        otherService.verify(requestWith({ [PROJECT_SESSION_COOKIE]: cookies[0]!.value })).ok,
      ).toBe(false);
    });

    it('rejects an expired session', () => {
      const service = new ProjectSessionService(config({ ttlSeconds: 300 }));
      const { response, cookies } = createResponse();
      service.issue(response, PROJECT_ID);

      jest.useFakeTimers().setSystemTime(Date.now() + 301_000);

      try {
        const result = service.verify(requestWith({ [PROJECT_SESSION_COOKIE]: cookies[0]!.value }));
        expect(result).toEqual({ ok: false, failure: 'EXPIRED' });
      } finally {
        jest.useRealTimers();
      }
    });

    it.each(['', 'no-separator', 'a.b.c.d'])('rejects malformed cookie %p', (value) => {
      expect(
        new ProjectSessionService(config()).verify(requestWith({ [PROJECT_SESSION_COOKIE]: value }))
          .ok,
      ).toBe(false);
    });
  });

  describe('verifyCsrf', () => {
    const service = new ProjectSessionService(config());

    it('accepts a matching cookie and header', () => {
      expect(
        service.verifyCsrf(
          requestWith({ [CSRF_COOKIE]: 'token-abc' }, { 'x-csrf-token': 'token-abc' }),
        ),
      ).toBe(true);
    });

    it('rejects a mismatch', () => {
      expect(
        service.verifyCsrf(
          requestWith({ [CSRF_COOKIE]: 'token-abc' }, { 'x-csrf-token': 'other' }),
        ),
      ).toBe(false);
    });

    it('rejects a missing header — a cross-site form cannot set one', () => {
      expect(service.verifyCsrf(requestWith({ [CSRF_COOKIE]: 'token-abc' }))).toBe(false);
    });

    it('rejects a missing cookie', () => {
      expect(service.verifyCsrf(requestWith({}, { 'x-csrf-token': 'token-abc' }))).toBe(false);
    });
  });

  describe('clear', () => {
    it('expires both cookies', () => {
      const { response, cookies } = createResponse();
      new ProjectSessionService(config()).clear(response);

      expect(cookies).toHaveLength(2);
      expect(cookies.every((cookie) => cookie.value === '' && cookie.options.maxAge === 0)).toBe(
        true,
      );
    });
  });
});
