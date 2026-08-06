import { HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import type {
  HealthCheckResult,
  HealthCheckService,
  MemoryHealthIndicator,
  MongooseHealthIndicator,
} from '@nestjs/terminus';
import { livenessResponseSchema, readinessResponseSchema } from '@wdrg/contracts';
import type { Response } from 'express';

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

function createController(check: jest.Mock) {
  const health = { check } as unknown as HealthCheckService;
  const mongoose = { pingCheck: jest.fn() } as unknown as MongooseHealthIndicator;
  const memory = { checkHeap: jest.fn() } as unknown as MemoryHealthIndicator;

  return new HealthController(health, mongoose, memory);
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

    it('checks both mongodb and heap usage', async () => {
      const check = jest.fn().mockResolvedValue(healthyResult);
      await createController(check).readiness(createResponse().response);

      expect(check).toHaveBeenCalledTimes(1);
      expect(check.mock.calls[0]?.[0]).toHaveLength(2);
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
