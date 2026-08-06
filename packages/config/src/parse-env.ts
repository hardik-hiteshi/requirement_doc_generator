import type { z } from 'zod';

/**
 * Thrown when the process environment does not satisfy the application schema.
 *
 * The message lists every offending variable so an operator can fix the whole
 * deployment in one pass instead of one restart per missing key. Values are
 * never included — only names and the reason — so a startup log can be shared
 * without leaking secrets.
 */
export class EnvironmentValidationError extends Error {
  public readonly issues: readonly EnvironmentIssue[];

  constructor(issues: readonly EnvironmentIssue[]) {
    const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`);

    super(
      [
        `Invalid environment configuration (${issues.length} problem${
          issues.length === 1 ? '' : 's'
        }):`,
        ...lines,
        '',
        'See .env.example for the full list of supported variables.',
      ].join('\n'),
    );

    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

export interface EnvironmentIssue {
  /** Name of the environment variable, e.g. `MONGODB_URI`. */
  readonly variable: string;
  /** Why it was rejected. Never contains the supplied value. */
  readonly message: string;
}

/**
 * Validates a raw environment record against a schema, throwing a single
 * aggregated error if anything is wrong.
 *
 * Startup calls this before any server is created, so a misconfigured process
 * fails immediately and loudly rather than at the first request that needs the
 * missing value.
 */
export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: Record<string, string | undefined>,
): z.infer<TSchema> {
  const result = schema.safeParse(source);

  if (result.success) {
    return result.data;
  }

  const issues: EnvironmentIssue[] = result.error.issues.map((issue) => ({
    variable: issue.path.length > 0 ? issue.path.join('.') : '(root)',
    message: issue.message,
  }));

  throw new EnvironmentValidationError(issues);
}
