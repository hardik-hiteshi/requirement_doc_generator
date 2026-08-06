import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { CSRF_COOKIE, PROJECT_SESSION_COOKIE } from '@wdrg/contracts';
import type { CookieOptions, Request, Response } from 'express';

import { AppConfigService } from '../config/app-config.service';

/**
 * Project sessions.
 *
 * A session is a signed, self-contained cookie rather than a database row. The
 * trade-off is deliberate: the only thing a session needs to assert is "the
 * bearer proved knowledge of this project's recovery secret before this
 * timestamp", which a signature carries perfectly well, and a stateless design
 * removes a collection, an index and a cleanup job from a product that has no
 * accounts to attach sessions to.
 *
 * The usual objection — that a stateless session cannot be revoked — does not
 * apply here. Every request loads the project and checks its status, so deleting
 * or expiring a project makes outstanding cookies useless immediately. There is
 * no other revocation case: there are no accounts, roles or passwords to change.
 */

interface SessionPayload {
  readonly projectId: string;
  /** Seconds since epoch. */
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface VerifiedSession {
  readonly projectId: string;
  readonly expiresAt: Date;
}

export type SessionFailure = 'ABSENT' | 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED';

export type SessionResult =
  | { readonly ok: true; readonly session: VerifiedSession }
  | { readonly ok: false; readonly failure: SessionFailure };

@Injectable()
export class ProjectSessionService {
  constructor(private readonly config: AppConfigService) {}

  /** Issues a session cookie and the paired CSRF cookie. */
  issue(response: Response, projectId: string): VerifiedSession {
    const now = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = now + this.config.session.ttlSeconds;

    const payload: SessionPayload = {
      projectId,
      issuedAt: now,
      expiresAt: expiresAtSeconds,
    };

    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const token = `${encoded}.${this.sign(encoded)}`;
    const expiresAt = new Date(expiresAtSeconds * 1000);

    response.cookie(PROJECT_SESSION_COOKIE, token, this.sessionCookieOptions(expiresAt));
    response.cookie(CSRF_COOKIE, this.generateCsrfToken(), this.csrfCookieOptions(expiresAt));

    return { projectId, expiresAt };
  }

  /** Reads and verifies the session cookie. */
  verify(request: Request): SessionResult {
    const raw = this.readCookie(request, PROJECT_SESSION_COOKIE);

    if (!raw) {
      return { ok: false, failure: 'ABSENT' };
    }

    const separator = raw.lastIndexOf('.');

    if (separator <= 0) {
      return { ok: false, failure: 'MALFORMED' };
    }

    const encoded = raw.slice(0, separator);
    const signature = raw.slice(separator + 1);

    // Signature first: never parse attacker-controlled JSON that has not been
    // authenticated.
    if (!this.signatureMatches(encoded, signature)) {
      return { ok: false, failure: 'BAD_SIGNATURE' };
    }

    let payload: SessionPayload;

    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    } catch {
      return { ok: false, failure: 'MALFORMED' };
    }

    if (
      typeof payload?.projectId !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      payload.projectId.length === 0
    ) {
      return { ok: false, failure: 'MALFORMED' };
    }

    if (payload.expiresAt * 1000 <= Date.now()) {
      return { ok: false, failure: 'EXPIRED' };
    }

    return {
      ok: true,
      session: { projectId: payload.projectId, expiresAt: new Date(payload.expiresAt * 1000) },
    };
  }

  /** Clears both cookies. Used by logout and immediately after deletion. */
  clear(response: Response): void {
    const expired = new Date(0);

    response.cookie(PROJECT_SESSION_COOKIE, '', {
      ...this.sessionCookieOptions(expired),
      maxAge: 0,
    });
    response.cookie(CSRF_COOKIE, '', { ...this.csrfCookieOptions(expired), maxAge: 0 });
  }

  /**
   * Double-submit CSRF check.
   *
   * A cross-site page can cause the browser to send our cookies, but it cannot
   * *read* them, so it cannot copy the CSRF cookie into a request header. The
   * two matching is therefore evidence the request came from our own origin.
   * `SameSite` already blocks most of this class of attack; this is the second
   * layer, because `SameSite` behaviour still varies between browsers.
   */
  verifyCsrf(request: Request): boolean {
    const cookieToken = this.readCookie(request, CSRF_COOKIE);
    const headerToken = request.get('x-csrf-token');

    if (!cookieToken || !headerToken) {
      return false;
    }

    const cookieBuffer = Buffer.from(cookieToken, 'utf8');
    const headerBuffer = Buffer.from(headerToken, 'utf8');

    if (cookieBuffer.length !== headerBuffer.length) {
      return false;
    }

    return timingSafeEqual(cookieBuffer, headerBuffer);
  }

  private generateCsrfToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private sign(value: string): string {
    return createHmac('sha256', this.config.session.secret).update(value).digest('base64url');
  }

  private signatureMatches(value: string, candidate: string): boolean {
    const expected = Buffer.from(this.sign(value), 'utf8');
    const actual = Buffer.from(candidate, 'utf8');

    if (expected.length !== actual.length) {
      return false;
    }

    return timingSafeEqual(expected, actual);
  }

  private readCookie(request: Request, name: string): string | undefined {
    // cookie-parser types `cookies` loosely; narrow it before use rather than
    // trusting an `any` to flow into signature verification.
    const cookies: unknown = (request as Request & { cookies?: unknown }).cookies;

    if (typeof cookies !== 'object' || cookies === null) {
      return undefined;
    }

    const value = (cookies as Record<string, unknown>)[name];

    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private sessionCookieOptions(expires: Date): CookieOptions {
    return {
      // Script must never read this: an XSS bug would otherwise hand over the
      // whole project.
      httpOnly: true,
      // Only over TLS in production. Left off in development so the cookie works
      // over plain http on localhost.
      secure: this.config.isProduction,
      // Lax rather than Strict: the recovery link is a top-level navigation from
      // wherever the user saved it (an email, a notes app), and Strict would
      // drop the cookie on that first navigation. Lax still blocks the
      // cross-site POSTs that CSRF depends on.
      sameSite: 'lax',
      path: '/',
      expires,
    };
  }

  private csrfCookieOptions(expires: Date): CookieOptions {
    return {
      // Deliberately readable by script — that is what makes double-submit work.
      httpOnly: false,
      secure: this.config.isProduction,
      sameSite: 'lax',
      path: '/',
      expires,
    };
  }
}
