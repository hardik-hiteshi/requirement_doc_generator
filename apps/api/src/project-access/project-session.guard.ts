import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  type CallHandler,
} from '@nestjs/common';
import {
  API_ERROR_CODES,
  CSRF_FAILED_MESSAGE,
  PROJECT_ACCESS_DENIED_MESSAGE,
  type AccessDeniedReason,
} from '@wdrg/contracts';
import type { Request } from 'express';

import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { AppConfigService } from '../config/app-config.service';
import { ProjectSessionService } from './project-session.service';

/** The session, attached to the request once the guard has verified it. */
export interface AuthenticatedRequest extends Request {
  projectSession?: { projectId: string; expiresAt: Date };
}

/**
 * Guards every project operation.
 *
 * Three checks, in order:
 *
 * 1. **Session cookie** — signed, unexpired, and naming a project.
 * 2. **Origin** — for state-changing methods, the `Origin` header must be one we
 *    allow. This catches cross-site requests before any work is done.
 * 3. **CSRF double-submit** — the readable CSRF cookie must match the header.
 *
 * Origin and CSRF are both applied because neither is sufficient alone: some
 * clients omit `Origin`, and `SameSite` enforcement still varies across
 * browsers. Together they leave no gap that a single browser quirk opens.
 */
@Injectable()
export class ProjectSessionGuard implements CanActivate {
  private readonly logger = new Logger(ProjectSessionGuard.name);

  constructor(
    private readonly sessions: ProjectSessionService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const correlationId = requestId(request);
    const mutating = isMutating(request.method);

    const result = this.sessions.verify(request);

    if (!result.ok) {
      const reason: AccessDeniedReason =
        result.failure === 'EXPIRED' ? 'SESSION_EXPIRED' : 'NO_SESSION';

      await this.deny(reason, correlationId, undefined, PROJECT_ACCESS_DENIED_MESSAGE);
    }

    const session = result.ok ? result.session : undefined;

    if (mutating) {
      if (!this.originAllowed(request)) {
        await this.deny(
          'CSRF_FAILED',
          correlationId,
          session?.projectId,
          CSRF_FAILED_MESSAGE,
          'origin_rejected',
        );
      }

      if (!this.sessions.verifyCsrf(request)) {
        await this.deny('CSRF_FAILED', correlationId, session?.projectId, CSRF_FAILED_MESSAGE);
      }
    }

    request.projectSession = session;
    return true;
  }

  /**
   * A same-origin request from a browser may legitimately omit `Origin` (older
   * browsers on same-origin GETs), so an absent header is not treated as an
   * attack. A *present* header that we do not recognise is.
   */
  private originAllowed(request: Request): boolean {
    const origin = request.get('origin');

    if (!origin) {
      return true;
    }

    return this.config.security.allowedOrigins.includes(origin);
  }

  private async deny(
    reason: AccessDeniedReason,
    correlationId: string,
    projectId: string | undefined,
    message: string,
    detail?: string,
  ): Promise<never> {
    await this.audit.record({
      type: 'PROJECT_ACCESS_DENIED',
      projectId,
      correlationId,
      reason,
      ...(detail ? { metadata: { detail } } : {}),
    });

    this.logger.warn({ reason, projectId, correlationId, detail }, 'Project access denied');

    throw new AppException(API_ERROR_CODES.UNAUTHORIZED, { message });
  }
}

function isMutating(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function requestId(request: Request): string {
  const id = (request as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : 'unknown';
}

/** Re-exported so controllers can type the request without importing express. */
export type { CallHandler };
