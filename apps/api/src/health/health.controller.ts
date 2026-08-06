import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  Res,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  HealthCheckService,
  MemoryHealthIndicator,
  MongooseHealthIndicator,
  type HealthCheckResult,
} from '@nestjs/terminus';
import type { LivenessResponse, ReadinessResponse } from '@wdrg/contracts';
import type { Response } from 'express';

import { API_SERVICE_NAME, API_SERVICE_VERSION } from '../app.constants';
import { AppConfigService } from '../config/app-config.service';
import { MALWARE_SCANNER_PORT, type MalwareScannerPort } from '../ports';

/** Heap ceiling above which the process is considered unhealthy. */
const HEAP_LIMIT_BYTES = 512 * 1024 * 1024;

/** What Terminus expects one indicator to return. */
type IndicatorResult = Record<string, { status: 'up' | 'down'; [key: string]: unknown }>;

/**
 * Operational probes.
 *
 * Deliberately version-neutral (`/api/health/*`): orchestrators, load balancers
 * and uptime monitors must not need reconfiguring when the business API moves to
 * v2.
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly mongoose: MongooseHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly config: AppConfigService,
    @Inject(MALWARE_SCANNER_PORT) private readonly scanner: MalwareScannerPort,
  ) {}

  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Reports whether the process is running. Checks no external dependency, so a database outage never causes an orchestrator to restart a healthy instance.',
  })
  @ApiOkResponse({ description: 'The process is alive.' })
  liveness(): LivenessResponse {
    return {
      status: 'ok',
      service: API_SERVICE_NAME,
      version: API_SERVICE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Scanner health, as a readiness indicator.
   *
   * Only reported as *down* where a scanner is configured and unreachable. A
   * deployment running `none` is not broken — it is configured that way, and
   * production refuses that configuration at startup — so reporting it down
   * would make every development instance permanently unready.
   *
   * Where ClamAV *is* configured, an unreachable daemon makes this instance
   * unready, because with fail-closed policy it can no longer accept uploads.
   */
  private async checkScanner(): Promise<IndicatorResult> {
    if (this.config.malware.scanner !== 'clamav') {
      return {
        malware_scanner: {
          status: 'up',
          configured: this.config.malware.scanner,
          scanning: false,
        },
      };
    }

    const health = await this.scanner.health();

    return {
      malware_scanner: {
        status: health.available ? 'up' : 'down',
        configured: 'clamav',
        scanning: health.available,
        ...(health.signatureVersion ? { signatureVersion: health.signatureVersion } : {}),
      },
    };
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe',
    description:
      'Reports whether this instance can serve traffic. Checks every dependency required to handle a request: MongoDB, process memory, and — where one is configured — the malware scanner.',
  })
  @ApiOkResponse({ description: 'Every dependency is reachable.' })
  @ApiServiceUnavailableResponse({ description: 'At least one dependency is unavailable.' })
  async readiness(@Res({ passthrough: true }) response: Response): Promise<ReadinessResponse> {
    try {
      return toReadinessResponse(
        await this.health.check([
          () => this.mongoose.pingCheck('mongodb'),
          () => this.memory.checkHeap('memory_heap', HEAP_LIMIT_BYTES),
          () => this.checkScanner(),
        ]),
      );
    } catch (error) {
      // Terminus signals failure by throwing, with the full per-indicator report
      // as the response body. That report is exactly what an operator needs, so
      // it is returned as-is rather than being flattened into the generic error
      // envelope by the global filter.
      if (error instanceof ServiceUnavailableException) {
        response.status(HttpStatus.SERVICE_UNAVAILABLE);
        return toReadinessResponse(error.getResponse() as HealthCheckResult);
      }

      throw error;
    }
  }
}

/**
 * Normalises Terminus's result into the shared contract.
 *
 * Terminus types `info` and `error` as partial records whose values may be
 * `undefined`; the contract promises a defined entry per key. Dropping the
 * undefined entries here keeps that promise, rather than casting it away and
 * letting a consumer trip over a missing `status`.
 */
function toReadinessResponse(result: HealthCheckResult): ReadinessResponse {
  const info = toIndicatorRecord(result.info);
  const error = toIndicatorRecord(result.error);

  return {
    status: result.status,
    ...(info ? { info } : {}),
    ...(error ? { error } : {}),
    details: toIndicatorRecord(result.details) ?? {},
  };
}

type IndicatorRecord = NonNullable<ReadinessResponse['info']>;

function toIndicatorRecord(
  source: Partial<HealthCheckResult['details']> | undefined,
): IndicatorRecord | undefined {
  if (!source) {
    return undefined;
  }

  const entries = Object.entries(source).filter(
    (entry): entry is [string, IndicatorRecord[string]] => entry[1] !== undefined,
  );

  return Object.fromEntries(entries);
}
