import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType, infer as ZodInfer } from 'zod';

import { ZodValidationPipe, type ZodValidationPipeOptions } from '../pipes/zod-validation.pipe';

/**
 * Pairs a request schema with an explicit mapping into a domain type.
 *
 * ## Why this exists
 *
 * Schema validation alone does not prevent over-posting. It guarantees the
 * parsed value has only *declared* properties, but says nothing about whether a
 * declared property should be client-settable, and nothing at all about what
 * happens after the controller: passing a validated body straight into a
 * repository is what actually causes mass assignment, and no amount of parsing
 * upstream prevents it.
 *
 * The mapper closes that gap by making the transformation explicit and typed.
 * The pipe's output is the **domain** type, not the request type, so a
 * controller physically cannot forward the raw body onward — there is no value
 * of the request type in scope to forward.
 *
 * ## The rule this enforces
 *
 * A repository or persistence layer never accepts a request-shaped type. The
 * chain is always:
 *
 * ```
 * request body ──(strict schema)──▶ validated input ──(explicit map)──▶ domain
 *   ──(repository maps)──▶ persistence document
 * ```
 *
 * Each arrow is a place where a field must be named to survive. A field nobody
 * named cannot reach the database.
 *
 * @example
 * ```ts
 * const createProject = createRequestMapper(createProjectSchema, (input) => ({
 *   name: input.projectName.trim(),
 *   clientName: input.clientName ?? null,
 *   // status is NOT taken from input: the domain owns it.
 *   status: 'draft' as const,
 * }));
 *
 * @Post()
 * create(@Body(createProject) command: CreateProjectCommand) {
 *   //     ^ CreateProjectCommand, never CreateProjectInput
 *   return this.projects.create(command);
 * }
 * ```
 */
@Injectable()
export class RequestMapperPipe<TSchema extends ZodType, TDomain> implements PipeTransform<
  unknown,
  TDomain
> {
  private readonly validation: ZodValidationPipe<TSchema>;

  constructor(
    schema: TSchema,
    private readonly map: (input: ZodInfer<TSchema>) => TDomain,
    options: ZodValidationPipeOptions = {},
  ) {
    this.validation = new ZodValidationPipe(schema, options);
  }

  transform(value: unknown): TDomain {
    // Annotated so the generic parse result is narrowed before mapping; without
    // it the inferred type widens and the call reads as unsafe.
    const input: ZodInfer<TSchema> = this.validation.transform(value);
    return this.map(input);
  }
}

/**
 * Convenience factory so a controller can declare the mapper inline.
 *
 * @see RequestMapperPipe for the rule this enforces.
 */
export function createRequestMapper<TSchema extends ZodType, TDomain>(
  schema: TSchema,
  map: (input: ZodInfer<TSchema>) => TDomain,
  options: ZodValidationPipeOptions = {},
): RequestMapperPipe<TSchema, TDomain> {
  return new RequestMapperPipe(schema, map, options);
}
