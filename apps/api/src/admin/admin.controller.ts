import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { ApiExcludeController, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  adminAuditQuerySchema,
  adminProjectQuerySchema,
  API_ERROR_CODES,
  METRIC_NAMES,
  PROJECT_STATUSES,
  type AdminAuditQuery,
  type AdminAuditResponse,
  type AdminConfig,
  type AdminProjectDetail,
  type AdminProjectList,
  type AdminProjectQuery,
  type AdminQueueState,
  type AdminStatus,
  type AuditEventType,
  type ProjectStatus,
} from '@wdrg/contracts';
import type { Request } from 'express';
import type { Connection } from 'mongoose';

import { API_SERVICE_VERSION } from '../app.constants';
import { AuditService } from '../audit/audit.service';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AppConfigService } from '../config/app-config.service';
import { MetricsService } from '../observability/metrics.service';
import { RateLimitStore } from '../abuse/rate-limit.store';
import { RetentionService } from '../retention/retention.service';
import { RetentionWorker } from '../retention/retention.worker';
import { AppException } from '../common/errors';
import { AdminProjectsService } from './admin-projects.service';
import { AdminQueueService } from './admin-queue.service';
import { AdminGuard } from './admin.guard';

/**
 * What an operator can see, and the one thing they can do.
 *
 * Excluded from the OpenAPI document deliberately. The document is served publicly
 * in non-production and describes the client API; advertising an operator surface
 * there tells every reader where to look and what to send. An operator has the
 * deployment's documentation, which is where these are described.
 *
 * Read-only apart from triggering a retention sweep — and that does exactly what the
 * timer does. It cannot purge anything the configured policy would not have purged
 * on its own, so the worst an operator can do with it is make scheduled work happen
 * sooner.
 */
@ApiTags('Operations')
@ApiExcludeController()
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(getConnectionToken()) private readonly connection: Connection,
    private readonly config: AppConfigService,
    private readonly metrics: MetricsService,
    private readonly rateLimits: RateLimitStore,
    private readonly retention: RetentionService,
    private readonly worker: RetentionWorker,
    private readonly audit: AuditService,
    private readonly adminProjects: AdminProjectsService,
    private readonly adminQueue: AdminQueueService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'What this instance is doing' })
  @ApiOkResponse({ description: 'Operational status.' })
  async status(@Req() request: Request): Promise<AdminStatus> {
    await this.recordAction(request, 'status');

    const counts = Object.fromEntries(
      await Promise.all(
        PROJECT_STATUSES.map(async (status): Promise<[ProjectStatus, number]> => [
          status,
          await this.connection.collection('projects').countDocuments({ status }),
        ]),
      ),
    ) as Record<ProjectStatus, number>;

    const retention = this.config.retention;
    const lastSweep = this.retention.latestSweep();

    return {
      observedAt: new Date().toISOString(),
      version: API_SERVICE_VERSION,
      environment: this.config.nodeEnv,
      projects: counts,
      retention: {
        enabled: retention.enabled,
        deletionGraceDays: retention.policy.deletionGraceDays,
        expiredGraceDays: retention.policy.expiredGraceDays,
        ...(lastSweep ? { lastSweep } : {}),
        pendingDeletion: await this.retention.pendingDeletionCount(),
      },
      rateLimit: {
        enabled: this.config.rateLimit.enabled,
        trackedKeys: this.rateLimits.size(),
        refusals: this.metrics.readByLabel(METRIC_NAMES.rateLimitRefusalsTotal, 'class'),
      },
      storage: {
        adapter: this.config.upload.adapter,
        malwareScanner: this.config.malware.scanner,
      },
    };
  }

  @Get('audit')
  @ApiOperation({ summary: 'Recent audit events, filtered' })
  @ApiOkResponse({ description: 'Audit events, newest first.' })
  async auditEvents(
    @Query(new ZodValidationPipe(adminAuditQuerySchema)) query: AdminAuditQuery,
    @Req() request: Request,
  ): Promise<AdminAuditResponse> {
    await this.recordAction(request, 'audit');

    const filter: Record<string, unknown> = {};

    if (query.type) {
      filter.type = query.type;
    }

    if (query.projectId) {
      filter.projectId = query.projectId;
    }

    if (query.since) {
      filter.createdAt = { $gte: new Date(query.since) };
    }

    /* One more than asked for, which is how truncation is detected honestly. */
    const rows = await this.connection
      .collection('audit_events')
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .toArray();

    const truncated = rows.length > query.limit;

    return {
      events: rows.slice(0, query.limit).map((row) => ({
        type: row.type as AuditEventType,
        projectId: String(row.projectId ?? ''),
        ...(row.correlationId ? { correlationId: String(row.correlationId) } : {}),
        occurredAt: (row.createdAt instanceof Date ? row.createdAt : new Date()).toISOString(),
        ...(row.metadata ? { metadata: row.metadata as Record<string, unknown> } : {}),
      })),
      truncated,
    };
  }

  @Post('retention/run')
  @ApiOperation({ summary: 'Run a retention sweep now' })
  @ApiOkResponse({ description: 'What the sweep did.' })
  async runRetention(@Req() request: Request) {
    await this.recordAction(request, 'retention_run');

    await this.worker.runOnce();

    return { sweep: this.retention.latestSweep() };
  }

  @Get('projects')
  @ApiOperation({ summary: 'Projects, by status — metadata only' })
  @ApiOkResponse({ description: 'Matching projects, newest activity first.' })
  async projects(
    @Query(new ZodValidationPipe(adminProjectQuerySchema)) query: AdminProjectQuery,
    @Req() request: Request,
  ): Promise<AdminProjectList> {
    await this.recordAction(request, 'projects_list');

    return this.adminProjects.list(query);
  }

  @Get('projects/:projectId')
  @ApiOperation({ summary: 'One project — metadata and counts, never content' })
  @ApiOkResponse({ description: "The project's operational shape." })
  async project(@Param('projectId') projectId: string): Promise<AdminProjectDetail> {
    const detail = await this.adminProjects.detail(projectId);

    /*
     * Audited whether or not the project exists, and with the id either way. An
     * operator looking up a project is a thing that should be on the record — including
     * a lookup of something that is not there, which is what a probe looks like.
     */
    await this.audit.record({
      type: 'ADMIN_PROJECT_VIEWED',
      projectId,
      metadata: { found: detail !== undefined },
    });

    if (!detail) {
      throw new AppException(API_ERROR_CODES.NOT_FOUND, { message: 'No such project.' });
    }

    return detail;
  }

  @Get('queue')
  @ApiOperation({ summary: 'Extraction queue depth and the age of its oldest work' })
  @ApiOkResponse({ description: 'Queue state.' })
  async queue(@Req() request: Request): Promise<AdminQueueState> {
    await this.recordAction(request, 'queue');

    return this.adminQueue.state();
  }

  @Post('queue/:jobId/retry')
  @ApiOperation({ summary: 'Send a failed extraction job back to the queue' })
  @ApiOkResponse({ description: 'The job, as it now stands.' })
  async retryJob(@Param('jobId') jobId: string, @Req() request: Request) {
    await this.audit.record({
      type: 'ADMIN_JOB_RETRIED',
      projectId: 'system',
      metadata: { jobId, method: request.method },
    });

    return { job: await this.adminQueue.retry(jobId) };
  }

  @Get('config')
  @ApiOperation({ summary: 'The configuration this process resolved, redacted' })
  @ApiOkResponse({ description: 'Allow-listed settings, and which secrets are set.' })
  async effectiveConfig(@Req() request: Request): Promise<AdminConfig> {
    await this.recordAction(request, 'config');

    return { ...this.config.operationalSnapshot(), observedAt: new Date().toISOString() };
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({ summary: 'Metrics for a collector to scrape' })
  @ApiOkResponse({ description: 'Prometheus exposition text.' })
  metricsText(): string {
    /*
     * No audit event. A collector scrapes this every few seconds, and recording each
     * one would fill the trail with the fact that monitoring is working.
     */
    return this.metrics.render();
  }

  private async recordAction(request: Request, action: string): Promise<void> {
    await this.audit.record({
      type: 'ADMIN_ACTION',
      projectId: 'system',
      metadata: { action, method: request.method },
    });
  }
}
