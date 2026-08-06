import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { portSchema } from './env-schemas';
import { EnvironmentValidationError, parseEnv } from './parse-env';

const schema = z.object({
  MONGODB_URI: z.string().min(1),
  PORT: portSchema(3001),
  API_KEY: z.string().min(10),
});

describe('parseEnv', () => {
  it('returns the parsed, coerced configuration', () => {
    const parsed = parseEnv(schema, {
      MONGODB_URI: 'mongodb://localhost:27017/app',
      PORT: '4000',
      API_KEY: 'a-sufficiently-long-key',
    });

    expect(parsed).toEqual({
      MONGODB_URI: 'mongodb://localhost:27017/app',
      PORT: 4000,
      API_KEY: 'a-sufficiently-long-key',
    });
  });

  it('throws EnvironmentValidationError listing every problem at once', () => {
    let caught: unknown;

    try {
      parseEnv(schema, { PORT: 'not-a-port' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvironmentValidationError);
    const error = caught as EnvironmentValidationError;

    expect(error.issues.map((issue) => issue.variable).sort()).toEqual([
      'API_KEY',
      'MONGODB_URI',
      'PORT',
    ]);
    expect(error.message).toContain('3 problems');
  });

  it('never includes the offending value in the message', () => {
    let caught: unknown;

    try {
      parseEnv(schema, {
        MONGODB_URI: 'mongodb://localhost:27017/app',
        PORT: '4000',
        API_KEY: 'sk-super-secret',
      });
    } catch (error) {
      caught = error;
    }

    // The value is long enough, so this must succeed; guard the inverse case.
    expect(caught).toBeUndefined();

    try {
      parseEnv(schema, {
        MONGODB_URI: 'mongodb://localhost:27017/app',
        PORT: '4000',
        API_KEY: 'sk-short',
      });
    } catch (error) {
      expect((error as EnvironmentValidationError).message).not.toContain('sk-short');
    }
  });

  it('reports a singular problem correctly', () => {
    expect(() =>
      parseEnv(schema, {
        MONGODB_URI: 'mongodb://localhost:27017/app',
        PORT: '4000',
        API_KEY: 'short',
      }),
    ).toThrow(/\(1 problem\)/);
  });
});
