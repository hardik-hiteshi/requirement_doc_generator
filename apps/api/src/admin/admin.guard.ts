import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import {
  ADMIN_DISABLED_MESSAGE,
  ADMIN_TOKEN_HEADER,
  ADMIN_UNAUTHORIZED_MESSAGE,
  API_ERROR_CODES,
  METRIC_NAMES,
} from '@wdrg/contracts';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../observability/metrics.service';

/**
 * Lets an operator in, and nobody else.
 *
 * One token, from configuration. Absent means the surface does not exist: every
 * route behind this guard answers as though it were not implemented, rather than
 * admitting there is a door here whose key somebody could go looking for.
 *
 * ## Constant-time comparison
 *
 * `===` on a secret leaks its prefix through timing — an attacker who can measure
 * enough requests recovers the token one character at a time. `timingSafeEqual`
 * costs nothing here and removes the whole class of attack. It requires equal
 * lengths, so the lengths are compared first, which does leak the token's length;
 * that is not useful to an attacker facing a 32-character minimum of arbitrary
 * bytes.
 *
 * ## Every refusal is recorded
 *
 * A wrong token is the signal that somebody is trying, and it is the one thing an
 * operator most wants to see in the trail. The refusal itself says nothing useful
 * back: absent, malformed and wrong all answer identically.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const admin = this.config.admin;

    if (!admin.enabled) {
      await this.deny(request, 'surface_disabled');

      /*
       * 404, not 403. A deployment that has not enabled the operator surface should
       * be indistinguishable from one where these routes do not exist.
       */
      throw new AppException(API_ERROR_CODES.NOT_FOUND, { message: ADMIN_DISABLED_MESSAGE });
    }

    const presented = request.header(ADMIN_TOKEN_HEADER) ?? '';

    if (!this.matches(presented, admin.token)) {
      await this.deny(request, presented.length === 0 ? 'token_absent' : 'token_mismatch');

      throw new AppException(API_ERROR_CODES.UNAUTHORIZED, {
        message: ADMIN_UNAUTHORIZED_MESSAGE,
      });
    }

    return true;
  }

  private matches(presented: string, expected: string): boolean {
    const left = Buffer.from(presented, 'utf8');
    const right = Buffer.from(expected, 'utf8');

    if (left.byteLength !== right.byteLength) {
      return false;
    }

    return timingSafeEqual(left, right);
  }

  private async deny(request: Request, reason: string): Promise<void> {
    this.metrics.increment(METRIC_NAMES.adminDeniedTotal, { reason });

    await this.audit.record({
      type: 'ADMIN_ACCESS_DENIED',
      projectId: 'system',
      /* The reason and the method. Never the token, not even its length. */
      metadata: { reason, method: request.method },
    });
  }
}
