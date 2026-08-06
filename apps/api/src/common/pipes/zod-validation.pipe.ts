import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType, infer as ZodInfer } from 'zod';

import { ValidationFailedException } from '../errors/app.exception';

/**
 * How a payload containing properties the schema does not declare is handled.
 *
 * - `reject` (default) — the request fails with `VALIDATION_FAILED` naming the
 *   offending paths. Chosen as the default because a client sending a field the
 *   server does not know about is either out of date or probing, and both are
 *   worth surfacing rather than silently ignoring.
 * - `strip` — unknown keys are dropped and the request proceeds. For endpoints
 *   that must tolerate older or newer clients, and for schemas whose
 *   `.transform()` reshapes the payload (see the note on detection below).
 *   Every use must carry a comment explaining why the looser policy is
 *   acceptable there.
 */
export type UnknownKeyPolicy = 'reject' | 'strip';

export interface ZodValidationPipeOptions {
  readonly unknownKeys?: UnknownKeyPolicy;
}

/** Keys that can corrupt an object's prototype chain if they are ever assigned. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validates a request payload against a Zod schema and returns the parsed value.
 *
 * This is one layer of defence against over-posting, not a complete answer to
 * it. It guarantees the value leaving the pipe contains only properties the
 * schema declares — but it cannot know whether a *declared* property should be
 * settable by a client. A schema that declares `isApproved` will happily accept
 * `isApproved`. Preventing that is the job of the mapping layer
 * (`createRequestMapper`), where a validated input becomes a domain object
 * carrying only the fields the domain permits a caller to set.
 *
 * ## How unknown keys are detected
 *
 * Zod strips undeclared keys during parsing, so the parsed output is compared
 * against the input and any key that did not survive is reported. This is done
 * rather than walking the schema and applying `.strict()` because `.strict()`
 * applies to a single object level and does not reach through `.optional()`,
 * `.nullable()` or array wrappers — a nested unexpected property would pass
 * unnoticed. The diff is schema-agnostic and depends on no Zod internals.
 *
 * It also closes a gap in `.strict()` itself: Zod does not report `__proto__` as
 * an unknown key even when it is an own enumerable property of the payload
 * (`JSON.parse` creates exactly that). Such keys are rejected explicitly.
 *
 * **Caveat:** a schema whose `.transform()` deliberately renames or removes keys
 * will look like it dropped unknown ones. Use `unknownKeys: 'strip'` for those,
 * and do the reshaping in the mapping layer instead.
 *
 * @example
 * ```ts
 * @Post()
 * create(@Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput) {}
 * ```
 */
@Injectable()
export class ZodValidationPipe<TSchema extends ZodType> implements PipeTransform<unknown> {
  private readonly unknownKeys: UnknownKeyPolicy;

  constructor(
    private readonly schema: TSchema,
    options: ZodValidationPipeOptions = {},
  ) {
    this.unknownKeys = options.unknownKeys ?? 'reject';
  }

  transform(value: unknown): ZodInfer<TSchema> {
    // Prototype-polluting keys are refused under either policy: there is no
    // legitimate request that carries one, and stripping silently would hide a
    // deliberate probe.
    const forbidden = findForbiddenKeys(value);

    if (forbidden.length > 0) {
      throw new ValidationFailedException(
        forbidden.map((path) => ({
          path,
          message: 'Property name is not allowed.',
          rule: 'forbidden_key',
        })),
      );
    }

    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new ValidationFailedException(
        result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          rule: issue.code,
        })),
      );
    }

    if (this.unknownKeys === 'reject') {
      const unknown = findUnknownPaths(value, result.data);

      if (unknown.length > 0) {
        throw new ValidationFailedException(
          unknown.map((path) => ({
            path,
            message: 'Unrecognised property.',
            rule: 'unrecognized_keys',
          })),
        );
      }
    }

    return result.data;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collects the paths of any prototype-polluting key anywhere in the payload. */
function findForbiddenKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${index}]`));
  }

  if (!isPlainObject(value)) {
    return [];
  }

  const found: string[] = [];

  for (const key of Object.keys(value)) {
    const childPath = path ? `${path}.${key}` : key;

    if (FORBIDDEN_KEYS.has(key)) {
      found.push(childPath);
      continue;
    }

    found.push(...findForbiddenKeys(value[key], childPath));
  }

  return found;
}

/**
 * Collects the paths present in the input that did not survive parsing, at any
 * depth.
 */
function findUnknownPaths(input: unknown, parsed: unknown, path = ''): string[] {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    return input.flatMap((item, index) =>
      findUnknownPaths(item, parsed[index], `${path}[${index}]`),
    );
  }

  if (!isPlainObject(input) || !isPlainObject(parsed)) {
    return [];
  }

  const found: string[] = [];

  for (const key of Object.keys(input)) {
    const childPath = path ? `${path}.${key}` : key;

    // An explicit `undefined` is indistinguishable from an absent optional
    // property after parsing, so it is not treated as unknown.
    if (input[key] === undefined) {
      continue;
    }

    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      found.push(childPath);
      continue;
    }

    found.push(...findUnknownPaths(input[key], parsed[key], childPath));
  }

  return found;
}
