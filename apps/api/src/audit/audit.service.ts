import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isRecoverySecret, type AuditEventType } from '@wdrg/contracts';
import { Model } from 'mongoose';

import { AuditEvent, type AuditEventDocument } from './schemas/audit-event.schema';

export interface RecordAuditEvent {
  readonly type: AuditEventType;
  readonly projectId?: string;
  readonly correlationId?: string;
  /** Internal reason code — see AccessDeniedReason for the access cases. */
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

/** Metadata keys that must never be persisted, whatever a caller passes. */
const FORBIDDEN_METADATA_KEYS = new Set([
  'recoverySecret',
  'secret',
  'password',
  'token',
  'sessionToken',
  'cookie',
  'authorization',
  'secretHash',
  'hash',
  'salt',
]);

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@InjectModel(AuditEvent.name) private readonly model: Model<AuditEventDocument>) {}

  /**
   * Appends an audit event.
   *
   * Deliberately never throws. An audit write failing is worth knowing about,
   * but it must not turn a successful project update into a 500 — the user's
   * work is already committed, and failing the response would be both confusing
   * and, on a retry, duplicative.
   */
  async record(event: RecordAuditEvent): Promise<void> {
    try {
      await this.model.create({
        type: event.type,
        projectId: event.projectId,
        correlationId: event.correlationId,
        reason: event.reason,
        metadata: event.metadata ? sanitizeMetadata(event.metadata) : undefined,
      });
    } catch (error) {
      this.logger.error(
        {
          auditType: event.type,
          projectId: event.projectId,
          correlationId: event.correlationId,
          err: error instanceof Error ? { name: error.name, message: error.message } : undefined,
        },
        'Failed to record audit event',
      );
    }
  }

  async findForProject(projectId: string, limit = 50): Promise<AuditEvent[]> {
    return this.model
      .find({ projectId })
      .sort({ occurredAt: -1 })
      .limit(limit)
      .lean<AuditEvent[]>()
      .exec();
  }
}

/**
 * Strips anything secret-shaped from audit metadata.
 *
 * Two independent checks, because either alone has a gap: the key list catches
 * a value that does not look like a secret, and the value check catches a secret
 * filed under an innocuous key. Both are needed for a defence that does not
 * depend on every future caller remembering the rule.
 */
export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (FORBIDDEN_METADATA_KEYS.has(key)) {
      safe[key] = '[redacted]';
      continue;
    }

    if (typeof value === 'string' && isRecoverySecret(value)) {
      safe[key] = '[redacted]';
      continue;
    }

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      safe[key] = sanitizeMetadata(value as Record<string, unknown>);
      continue;
    }

    safe[key] = value;
  }

  return safe;
}
