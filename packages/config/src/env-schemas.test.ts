import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  booleanFromString,
  csvSchema,
  httpUrlSchema,
  integerSchema,
  logLevelSchema,
  mongoUriSchema,
  nodeEnvSchema,
  portSchema,
  secretSchema,
} from './env-schemas';

describe('booleanFromString', () => {
  it.each(['true', 'TRUE', '1', 'yes', 'on'])('parses %s as true', (value) => {
    expect(booleanFromString(false).parse(value)).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'off'])('parses %s as false', (value) => {
    expect(booleanFromString(true).parse(value)).toBe(false);
  });

  it('applies the default when the variable is absent', () => {
    expect(booleanFromString(true).parse(undefined)).toBe(true);
  });

  it('rejects an ambiguous value instead of defaulting to false', () => {
    expect(() => booleanFromString(false).parse('maybe')).toThrow();
  });
});

describe('portSchema', () => {
  it('coerces a numeric string', () => {
    expect(portSchema(3000).parse('4100')).toBe(4100);
  });

  it('applies the default', () => {
    expect(portSchema(3000).parse(undefined)).toBe(3000);
  });

  it.each(['0', '65536', '-1', 'abc', '80.5'])('rejects %s', (value) => {
    expect(() => portSchema(3000).parse(value)).toThrow();
  });
});

describe('integerSchema', () => {
  const schema = integerSchema({ default: 10, min: 1, max: 100 });

  it('honours bounds', () => {
    expect(schema.parse('50')).toBe(50);
    expect(() => schema.parse('0')).toThrow();
    expect(() => schema.parse('101')).toThrow();
  });
});

describe('httpUrlSchema', () => {
  it('strips trailing slashes so URL joining is predictable', () => {
    expect(httpUrlSchema().parse('https://example.com/api/')).toBe('https://example.com/api');
  });

  it.each(['ftp://example.com', 'not-a-url', 'file:///etc/passwd'])('rejects %s', (value) => {
    expect(() => httpUrlSchema().parse(value)).toThrow();
  });
});

describe('mongoUriSchema', () => {
  it('accepts both mongodb schemes', () => {
    expect(mongoUriSchema().parse('mongodb://localhost:27017/db')).toContain('mongodb://');
    expect(mongoUriSchema().parse('mongodb+srv://host/db')).toContain('mongodb+srv://');
  });

  it('rejects a non-mongo connection string', () => {
    expect(() => mongoUriSchema().parse('postgres://localhost/db')).toThrow();
  });
});

describe('csvSchema', () => {
  it('splits and trims', () => {
    expect(csvSchema().parse('http://a.test, http://b.test')).toEqual([
      'http://a.test',
      'http://b.test',
    ]);
  });

  it('drops empty entries so no blank origin is ever produced', () => {
    expect(csvSchema().parse('a, ,b,')).toEqual(['a', 'b']);
  });

  it('applies the default list', () => {
    expect(csvSchema(['http://localhost:3000']).parse(undefined)).toEqual([
      'http://localhost:3000',
    ]);
  });
});

describe('secretSchema', () => {
  it('accepts a sufficiently long secret', () => {
    expect(secretSchema(8).parse('s3cr3t-value')).toBe('s3cr3t-value');
  });

  it('rejects a short secret', () => {
    expect(() => secretSchema(32).parse('short')).toThrow();
  });

  it.each(['change-me', 'CHANGE_ME', 'placeholder', 'todo'])('rejects placeholder %s', (value) => {
    expect(() => secretSchema(4).parse(value)).toThrow();
  });
});

describe('enum schemas', () => {
  it('defaults NODE_ENV to development', () => {
    expect(nodeEnvSchema.parse(undefined)).toBe('development');
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => nodeEnvSchema.parse('staging')).toThrow();
  });

  it('defaults the log level to info', () => {
    expect(logLevelSchema.parse(undefined)).toBe('info');
  });
});

describe('composition', () => {
  it('works inside an application-style schema', () => {
    const schema = z.object({
      NODE_ENV: nodeEnvSchema,
      PORT: portSchema(3001),
      CORS_ALLOWED_ORIGINS: csvSchema(['http://localhost:3000']),
    });

    expect(schema.parse({ PORT: '8080' })).toEqual({
      NODE_ENV: 'development',
      PORT: 8080,
      CORS_ALLOWED_ORIGINS: ['http://localhost:3000'],
    });
  });
});
