import { AI_TASK_LABELS, type AiFailureReason, type AiTaskId } from '@wdrg/contracts';
import type { ZodType } from 'zod';

/**
 * Turning a model's text into data the application will store — or refusing to.
 *
 * The rule this file exists to enforce: **unvalidated model output is never
 * persisted.** Not "usually", not "after a quick check". A language model
 * produces plausible text, and plausible text that happens to parse as JSON is
 * exactly what a requirement baseline must not be built from.
 *
 * Three stages, in order, each able to end the process:
 *
 * 1. **Extraction** — find the JSON in whatever the model wrapped it in.
 * 2. **Schema validation** — the published Zod schema, with unknown keys
 *    rejected rather than stripped.
 * 3. **Semantic validation** — the checks a schema cannot express: identifiers
 *    that must be unique, source references that must name a real source.
 *
 * A failure at stage 2 or 3 may be repaired, at most twice. A model that has
 * produced invalid output twice against the same schema is not one attempt from
 * getting it right; it is telling you the task is beyond it, and further
 * attempts cost minutes of local inference to reach the same answer.
 */

export interface SemanticIssue {
  readonly path: string;
  readonly message: string;
  /** Distinguishes a fixable mistake from a disqualifying one. */
  readonly reason: AiFailureReason;
}

export type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: AiFailureReason;
      /** Fed back to the model on a repair attempt. Never project content. */
      readonly issues: readonly SemanticIssue[];
    };

/**
 * Semantic checks a Zod schema cannot express.
 *
 * Kept separate from the schema because they need context the schema does not
 * have — which source ids exist in *this* project, which identifiers have
 * already been used in *this* run.
 */
export interface SemanticValidator<T> {
  validate(value: T): SemanticIssue[];
}

/**
 * Extracts a JSON object from model output.
 *
 * Models wrap JSON in prose, in fenced code blocks, and occasionally in both,
 * however firmly the prompt asks them not to. Refusing anything but a bare
 * object would fail on output that is entirely correct apart from three
 * backticks — so the wrapper is stripped, and the *content* is then held to the
 * full standard with no leniency at all.
 */
export function extractJson(raw: string): { ok: true; json: unknown } | { ok: false } {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false };
  }

  const candidates: string[] = [];

  // A fenced block, with or without a language tag.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);

  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }

  candidates.push(trimmed);

  // The outermost balanced object or array, for output with prose around it.
  const balanced = findBalanced(trimmed);

  if (balanced) {
    candidates.push(balanced);
  }

  for (const candidate of candidates) {
    try {
      const json: unknown = JSON.parse(candidate);

      // A bare string or number is not a task result, whatever it parsed as.
      if (typeof json === 'object' && json !== null) {
        return { ok: true, json };
      }
    } catch {
      // Try the next candidate. A parse failure here is expected, not
      // exceptional — that is the whole reason there is a list.
      continue;
    }
  }

  return { ok: false };
}

/** The outermost balanced `{}` or `[]` span, ignoring braces inside strings. */
function findBalanced(text: string): string | null {
  const start = firstIndexOfEither(text, '{', '[');

  if (start === -1) {
    return null;
  }

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;

      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function firstIndexOfEither(text: string, a: string, b: string): number {
  const first = text.indexOf(a);
  const second = text.indexOf(b);

  if (first === -1) return second;
  if (second === -1) return first;

  return Math.min(first, second);
}

/**
 * Validates raw model output against a schema and any semantic checks.
 *
 * Zod issues become `SemanticIssue`s so a repair prompt has one shape to
 * describe, and so the caller does not have to know which layer objected.
 */
export function validateOutput<T>(
  raw: string,
  schema: ZodType<T>,
  semantic?: SemanticValidator<T>,
): ValidationOutcome<T> {
  const extracted = extractJson(raw);

  if (!extracted.ok) {
    return {
      ok: false,
      reason: 'invalid_json',
      issues: [
        {
          path: '',
          message: 'The response did not contain a JSON object.',
          reason: 'invalid_json',
        },
      ],
    };
  }

  const parsed = schema.safeParse(extracted.json);

  if (!parsed.success) {
    return {
      ok: false,
      reason: 'schema_invalid',
      issues: parsed.error.issues.slice(0, 20).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        reason: 'schema_invalid' as const,
      })),
    };
  }

  const issues = semantic?.validate(parsed.data) ?? [];

  if (issues.length > 0) {
    // The first issue's reason drives the failure classification: a hallucinated
    // source reference is a different kind of problem from a duplicate id, and
    // only one of them is worth asking the model to fix.
    return {
      ok: false,
      reason: issues[0]?.reason ?? 'schema_invalid',
      issues: issues.slice(0, 20),
    };
  }

  return { ok: true, value: parsed.data };
}

/**
 * The message sent back to the model when asking it to try again.
 *
 * **Only the issues.** Not the previous output, not the evidence, not anything
 * else from the project. Two reasons, and both matter: resending the evidence
 * doubles the context on every attempt, which is how a repair loop causes the
 * overflow it was meant to avoid; and a repair prompt is a second place project
 * content could leak into, so it is kept free of it by construction.
 */
export function buildRepairInstruction(taskId: AiTaskId, issues: readonly SemanticIssue[]): string {
  const listed = issues
    .slice(0, 10)
    .map((issue) => (issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`))
    .join('\n');

  return [
    `Your previous response for "${AI_TASK_LABELS[taskId]}" did not satisfy the required output format.`,
    '',
    'Problems found:',
    listed,
    '',
    'Reply again with the complete result. Return only JSON, matching the schema exactly.',
    'Do not add fields that are not in the schema. Do not include any explanation.',
  ].join('\n');
}

/* ------------------------------------------------- common semantic checks */

/** Rejects reused identifiers, which make every downstream reference ambiguous. */
export function checkUniqueIds(items: readonly { id: string }[], path: string): SemanticIssue[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const item of items) {
    if (seen.has(item.id)) {
      duplicates.add(item.id);
    }

    seen.add(item.id);
  }

  return [...duplicates].slice(0, 10).map((id) => ({
    path,
    message: `Identifier "${id}" was used more than once. Every identifier must be unique.`,
    reason: 'duplicate_identifiers' as const,
  }));
}

/**
 * Rejects references to sources that are not in this project.
 *
 * The single most important check in this file. A model asked to cite its
 * sources will sometimes produce a citation that looks exactly right and refers
 * to nothing — and a requirement baseline whose citations do not resolve is
 * worse than one with no citations at all, because it invites a reader to trust
 * it.
 */
export function checkSourceReferences(
  references: readonly { sourceId: string; path: string }[],
  knownSourceIds: ReadonlySet<string>,
): SemanticIssue[] {
  const unknown = references.filter((reference) => !knownSourceIds.has(reference.sourceId));

  return unknown.slice(0, 10).map((reference) => ({
    path: reference.path,
    message: `Source "${reference.sourceId}" is not part of this project. Cite only the sources you were given.`,
    reason: 'hallucinated_source_reference' as const,
  }));
}

/** Rejects an item with no citation at all, which cannot be traced back. */
export function checkHasReferences(
  items: readonly { id: string; referenceCount: number }[],
  path: string,
): SemanticIssue[] {
  return items
    .filter((item) => item.referenceCount === 0)
    .slice(0, 10)
    .map((item) => ({
      path: `${path}.${item.id}`,
      message: `"${item.id}" has no source reference. Every requirement must cite the text it came from.`,
      reason: 'missing_source_reference' as const,
    }));
}
