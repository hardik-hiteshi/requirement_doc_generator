import { EnvironmentValidationError, parseEnv } from '@wdrg/config';

import { apiEnvSchema } from './env.schema';

const minimalEnv = {
  MONGODB_URI: 'mongodb://localhost:27017/wdrg_test',
};

describe('apiEnvSchema', () => {
  it('applies safe defaults when only the required variables are set', () => {
    const env = parseEnv(apiEnvSchema, minimalEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3001);
    expect(env.API_HOST).toBe('0.0.0.0');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.LOG_PRETTY).toBe(false);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:3000']);
    expect(env.OPENAPI_ENABLED).toBe(true);
  });

  it('fails when the database connection string is missing', () => {
    expect(() => parseEnv(apiEnvSchema, {})).toThrow(EnvironmentValidationError);
  });

  it('names the offending variable in the failure', () => {
    try {
      parseEnv(apiEnvSchema, {});
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as EnvironmentValidationError).issues[0]?.variable).toBe('MONGODB_URI');
    }
  });

  it('rejects a non-mongo connection string', () => {
    expect(() => parseEnv(apiEnvSchema, { MONGODB_URI: 'postgres://localhost/db' })).toThrow(
      EnvironmentValidationError,
    );
  });

  it('coerces numeric and boolean variables from their string form', () => {
    const env = parseEnv(apiEnvSchema, {
      ...minimalEnv,
      API_PORT: '8080',
      LOG_PRETTY: 'true',
      OPENAPI_ENABLED: 'false',
      REQUEST_BODY_LIMIT_BYTES: '2048',
    });

    expect(env.API_PORT).toBe(8080);
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.OPENAPI_ENABLED).toBe(false);
    expect(env.REQUEST_BODY_LIMIT_BYTES).toBe(2048);
  });

  it('parses a comma-separated CORS origin list', () => {
    const env = parseEnv(apiEnvSchema, {
      ...minimalEnv,
      CORS_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    });

    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseEnv(apiEnvSchema, { ...minimalEnv, API_PORT: '70000' })).toThrow(
      EnvironmentValidationError,
    );
  });

  it('rejects an ambiguous boolean rather than silently defaulting', () => {
    expect(() => parseEnv(apiEnvSchema, { ...minimalEnv, LOG_PRETTY: 'sometimes' })).toThrow(
      EnvironmentValidationError,
    );
  });
});
