import { z } from 'zod';

/** Recognised deployment environments. */
export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnvironment = (typeof NODE_ENVS)[number];

export const nodeEnvSchema = z.enum(NODE_ENVS).default('development');

/** Structured log levels, ordered from most to least verbose. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const logLevelSchema = z.enum(LOG_LEVELS).default('info');

/**
 * Environment variables are always strings. `booleanFromString` accepts the
 * conventional spellings and rejects anything ambiguous rather than silently
 * treating an unknown value as `false`.
 */
export function booleanFromString(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value, ctx) => {
      if (typeof value === 'boolean') {
        return value;
      }

      const normalized = value.trim().toLowerCase();

      if (['true', '1', 'yes', 'on'].includes(normalized)) {
        return true;
      }

      if (['false', '0', 'no', 'off'].includes(normalized)) {
        return false;
      }

      ctx.addIssue({
        code: 'custom',
        message: `Expected a boolean value (true/false), received "${value}"`,
      });

      return z.NEVER;
    });
}

/** A TCP port. */
export function portSchema(defaultValue: number) {
  return z.coerce.number().int().min(1).max(65_535).default(defaultValue);
}

/** A bounded positive integer, e.g. a size or count limit. */
export function integerSchema(options: { default: number; min?: number; max?: number }) {
  let schema = z.coerce.number().int();

  if (options.min !== undefined) {
    schema = schema.min(options.min);
  }

  if (options.max !== undefined) {
    schema = schema.max(options.max);
  }

  return schema.default(options.default);
}

/** An absolute http(s) URL with no trailing slash. */
export function httpUrlSchema(defaultValue?: string) {
  const schema = z
    .url()
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: 'Must be an http(s) URL',
    })
    .transform((value) => value.replace(/\/+$/, ''));

  return defaultValue === undefined ? schema : schema.default(defaultValue);
}

/** A MongoDB connection string. */
export function mongoUriSchema(defaultValue?: string) {
  const schema = z
    .string()
    .min(1)
    .refine((value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'), {
      message: 'Must start with mongodb:// or mongodb+srv://',
    });

  return defaultValue === undefined ? schema : schema.default(defaultValue);
}

/**
 * A comma-separated list, e.g. allowed CORS origins. Empty entries are dropped so
 * `"a, ,b"` yields `['a', 'b']` rather than an empty-string origin that would
 * silently match nothing.
 */
export function csvSchema(defaultValue: readonly string[] = []) {
  return z
    .union([z.string(), z.array(z.string())])
    .default([...defaultValue])
    .transform((value) => {
      const items = Array.isArray(value) ? value : value.split(',');
      return items.map((item) => item.trim()).filter((item) => item.length > 0);
    });
}

/**
 * A secret that must be supplied explicitly in production. `minLength` guards
 * against placeholder values being promoted from a development `.env`.
 */
export function secretSchema(minLength = 32) {
  return z
    .string()
    .min(minLength, `Must be at least ${minLength} characters`)
    .refine((value) => !/^(change[-_ ]?me|placeholder|secret|todo)$/i.test(value.trim()), {
      message: 'Must not be a placeholder value',
    });
}
