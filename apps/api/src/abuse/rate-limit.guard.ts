import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  API_ERROR_CODES,
  METRIC_NAMES,
  PROJECT_SESSION_COOKIE,
  RATE_LIMITED_MESSAGE,
  rateLimitKey,
  type RateLimitClass,
} from '@wdrg/contracts';
import type { Request, Response } from 'express';

import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../observability/metrics.service';
import { RATE_LIMIT_CLASS } from './rate-limit.decorator';
import { RateLimitStore } from './rate-limit.store';

interface SessionCarrying extends Request {
  projectSession?: { projectId: string };
}

/**
 * Refuses a caller who is asking for too much, too quickly.
 *
 * Runs ahead of the session guard, deliberately. A request that is going to be
 * refused for cost should be refused before anything expensive happens — and the
 * cheapest thing available is a counter, whereas verifying a session reads a cookie,
 * checks an HMAC and may write an audit event. Refusing first also means a flood of
 * unauthenticated requests cannot generate a flood of audit writes.
 *
 * Because it runs first, the session may not be attached yet, so the key is derived
 * from the session cookie's own claim where there is one. That claim is unverified,
 * which sounds worse than it is: a caller who forges another project's session id
 * can only spend that project's budget, cannot read anything with it, and would find
 * it far easier to simply use a different address. Keying on something unverified is
 * acceptable precisely because the key grants nothing.
 *
 * ## What a refusal says
 *
 * A 429 with `Retry-After`, and the standard envelope. It never says which limit was
 * hit or how much budget remains for other classes: that is a map of the ceilings,
 * and the person who wants that map is the one probing them. The message says
 * plainly that nothing was changed, because the common case is somebody's browser
 * retrying and they need to know their work is intact.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  /** Keys already audited in their current window, so one flood is one event. */
  private readonly auditedKeys = new Map<string, number>();

  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitStore,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const settings = this.config.rateLimit;

    if (!settings.enabled) {
      return true;
    }

    const request = context.switchToHttp().getRequest<SessionCarrying>();
    const response = context.switchToHttp().getResponse<Response>();

    const rateClass = this.classify(context, request);
    const policy = settings.policies[rateClass];

    const key = rateLimitKey({
      rateClass,
      sessionId: this.sessionKey(request),
      address: this.address(request),
    });

    const decision = this.store.consume(key, policy);

    /*
     * The headers go out on success too. A client that can see its own budget can
     * back off before it is refused, which is better for both sides than discovering
     * the ceiling by hitting it.
     */
    response.setHeader('x-ratelimit-limit', String(decision.limit));
    response.setHeader('x-ratelimit-remaining', String(decision.remaining));

    if (decision.allowed) {
      return true;
    }

    response.setHeader('retry-after', String(decision.retryAfterSeconds));
    this.metrics.increment(METRIC_NAMES.rateLimitRefusalsTotal, { class: rateClass });

    await this.recordOnce(key, rateClass, request);

    throw new AppException(API_ERROR_CODES.RATE_LIMITED, { message: RATE_LIMITED_MESSAGE });
  }

  /**
   * The class this request draws on.
   *
   * An explicit declaration wins. Otherwise the verb decides, which is the safe
   * default: an unannotated new endpoint lands in `mutation` or `default` rather
   * than in no class at all.
   */
  private classify(context: ExecutionContext, request: Request): RateLimitClass {
    const declared = this.reflector.getAllAndOverride<RateLimitClass | undefined>(
      RATE_LIMIT_CLASS,
      [context.getHandler(), context.getClass()],
    );

    if (declared) {
      return declared;
    }

    const method = request.method.toUpperCase();

    return method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'default' : 'mutation';
  }

  /** The session's own claim, unverified — see the class comment. */
  private sessionKey(request: SessionCarrying): string | undefined {
    if (request.projectSession?.projectId) {
      return request.projectSession.projectId;
    }

    const cookie = (request.cookies as Record<string, string> | undefined)?.[
      PROJECT_SESSION_COOKIE
    ];

    /*
     * The signed payload's first segment, not the whole token: the signature changes
     * per issue, so keying on the token itself would give one caller a fresh budget
     * every time their cookie was reissued.
     */
    return cookie ? cookie.split('.')[0] : undefined;
  }

  private address(request: Request): string {
    /*
     * `request.ip` already honours the trust-proxy setting, so a deployment behind a
     * reverse proxy gets the real client address and one that is not behind a proxy
     * cannot be told a false one through a header.
     */
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }

  /**
   * One audit event per key per window.
   *
   * Auditing every refusal would let a flood turn the audit trail into the outage:
   * ten thousand refused requests would become ten thousand writes to the collection
   * an investigation later has to read. One event per window says the same thing.
   */
  private async recordOnce(
    key: string,
    rateClass: RateLimitClass,
    request: SessionCarrying,
  ): Promise<void> {
    const now = Date.now();
    const windowMs = this.config.rateLimit.policies[rateClass].windowSeconds * 1_000;
    const lastAudited = this.auditedKeys.get(key);

    if (lastAudited !== undefined && now - lastAudited < windowMs) {
      return;
    }

    this.auditedKeys.set(key, now);

    /* The same bound the store has, for the same reason. */
    if (this.auditedKeys.size > this.config.rateLimit.maxKeys) {
      this.auditedKeys.clear();
    }

    const projectId = request.projectSession?.projectId;

    await this.audit.record({
      type: 'RATE_LIMIT_EXCEEDED',
      projectId: projectId ?? 'unknown',
      metadata: {
        /* The class and the method. Never the path, which can carry an id. */
        rateClass,
        method: request.method,
      },
    });
  }
}
