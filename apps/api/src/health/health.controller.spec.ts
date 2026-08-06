import { HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import type {
  HealthCheckResult,
  HealthCheckService,
  MemoryHealthIndicator,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { livenessResponseSchema, readinessResponseSchema } from '@wdrg/contracts';
import type { Response } from 'express';

import type { AppConfigService } from '../config/app-config.service';
import type { MalwareScannerPort } from '../ports';
import { HealthController } from './health.controller';

const healthyResult: HealthCheckResult = {
  status: 'ok',
  info: { mongodb: { status: 'up' }, memory_heap: { status: 'up' } },
  error: {},
  details: { mongodb: { status: 'up' }, memory_heap: { status: 'up' } },
};

const unhealthyResult: HealthCheckResult = {
  status: 'error',
  info: { memory_heap: { status: 'up' } },
  error: { mongodb: { status: 'down', message: 'connection refused' } },
  details: {
    memory_heap: { status: 'up' },
    mongodb: { status: 'down', message: 'connection refused' },
  },
};

function createController(check: jest.Mock, scanner: 'clamav' | 'none' = 'none') {
  const health = { check } as unknown as HealthCheckService;
  const mongoose = { pingCheck: jest.fn() } as unknown as MongooseHealthIndicator;
  const memory = { checkHeap: jest.fn() } as unknown as MemoryHealthIndicator;
  const config = { malware: { scanner } } as unknown as AppConfigService;
  const malware = {
    scan: jest.fn(),
    health: jest.fn().mockResolvedValue({ available: true, engine: 'clamav' }),
  } as unknown as MalwareScannerPort;

  return new HealthController(health, mongoose, memory, config, malware);
}

function createResponse() {
  const status = jest.fn();
  return { response: { status } as unknown as Response, status };
}

describe('HealthController', () => {
  describe('liveness', () => {
    it('matches the shared contract', () => {
      const result = createController(jest.fn()).liveness();

      expect(livenessResponseSchema.safeParse(result).success).toBe(true);
      expect(result.status).toBe('ok');
    });

    it('reports a non-negative uptime and an ISO timestamp', () => {
      const result = createController(jest.fn()).liveness();

      expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
    });

    it('never touches a dependency', () => {
      const check = jest.fn();
      createController(check).liveness();

      expect(check).not.toHaveBeenCalled();
    });
  });

  describe('readiness', () => {
    it('returns the dependency report when everything is up', async () => {
      const { response, status } = createResponse();
      const controller = createController(jest.fn().mockResolvedValue(healthyResult));

      const result = await controller.readiness(response);

      expect(readinessResponseSchema.safeParse(result).success).toBe(true);
      expect(result.status).toBe('ok');
      expect(result.details.mongodb?.status).toBe('up');
      expect(status).not.toHaveBeenCalled();
    });

    it('checks mongodb, heap usage and the malware scanner', async () => {
      const check = jest.fn().mockResolvedValue(healthyResult);
      await createController(check).readiness(createResponse().response);

      expect(check).toHaveBeenCalledTimes(1);
      // MongoDB, heap, and the scanner — a control that is silently broken is
      // worse than one that is absent, so readiness has to see it.
      expect(check.mock.calls[0]?.[0]).toHaveLength(3);
    });

    it('answers 503 with the failing indicator when a dependency is down', async () => {
      const { response, status } = createResponse();
      const controller = createController(
        jest.fn().mockRejectedValue(new ServiceUnavailableException(unhealthyResult)),
      );

      const result = await controller.readiness(response);

      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(result.status).toBe('error');
      expect(result.error?.mongodb?.status).toBe('down');
      expect(readinessResponseSchema.safeParse(result).success).toBe(true);
    });

    it('rethrows anything that is not a health failure', async () => {
      const controller = createController(jest.fn().mockRejectedValue(new Error('bug in probe')));

      await expect(controller.readiness(createResponse().response)).rejects.toThrow('bug in probe');
    });
  });
});
