import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { AUDIT_EVENT_TYPES, type AuditEventType } from '@wdrg/contracts';
import { HydratedDocument } from 'mongoose';

export type AuditEventDocument = HydratedDocument<AuditEvent>;

/**
 * An append-only record of a security-relevant action.
 *
 * `metadata` is free-form so each event type can carry what it needs, but what
 * may go in it is constrained by policy rather than by the schema: never a
 * recovery secret, never a session token, never a request body. The audit
 * service is the only writer, and it is where that policy is enforced.
 */
@Schema({
  collection: 'audit_events',
  timestamps: { createdAt: 'occurredAt', updatedAt: false },
  id: false,
  versionKey: false,
})
export class AuditEvent {
  // Every `@Prop` states its type explicitly rather than relying on emitted
  // decorator metadata. A union of string literals has no runtime type to
  // reflect from at all, and an optional property reflects differently
  // depending on which compiler builds the file. Stating it removes both.
  @Prop({ type: String, required: true, enum: AUDIT_EVENT_TYPES, index: true })
  type!: AuditEventType;

  /**
   * Public project id, not the Mongo `_id`. Nullable because a failed recovery
   * may reference a project that does not exist.
   */
  @Prop({ type: String, index: true })
  projectId?: string;

  /** Ties the event to the request's structured log lines. */
  @Prop({ type: String, index: true })
  correlationId?: string;

  /** Internal reason code. Never mirrored into an API response. */
  @Prop({ type: String })
  reason?: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  occurredAt!: Date;
}

export const AuditEventSchema = SchemaFactory.createForClass(AuditEvent);

/*
 * Indexes support the two questions actually asked of this collection:
 * "what happened to this project" and "what happened recently, by type".
 */
AuditEventSchema.index({ projectId: 1, occurredAt: -1 }, { name: 'project_timeline' });
AuditEventSchema.index({ type: 1, occurredAt: -1 }, { name: 'type_timeline' });
