import { z } from 'zod';

import { ValidationFailedException } from '../errors/app.exception';
import { createRequestMapper } from './request-mapper';

/* A representative request schema and the domain command it maps to. The domain
   deliberately does NOT expose every field the request carries, and carries
   fields the request cannot set. */

const createProjectSchema = z.object({
  projectName: z.string().min(1),
  clientName: z.string().optional(),
});

interface CreateProjectCommand {
  readonly name: string;
  readonly clientName: string | null;
  /** Owned by the domain. A client must never be able to set it. */
  readonly status: 'draft';
}

const createProject = createRequestMapper(createProjectSchema, (input): CreateProjectCommand => ({
  name: input.projectName.trim(),
  clientName: input.clientName ?? null,
  status: 'draft',
}));

describe('createRequestMapper', () => {
  it('produces the domain command, not the request shape', () => {
    expect(createProject.transform({ projectName: '  Acme portal  ' })).toEqual({
      name: 'Acme portal',
      clientName: null,
      status: 'draft',
    });
  });

  it('emits only the properties the mapping names', () => {
    const result = createProject.transform({ projectName: 'Acme', clientName: 'Acme Ltd' });

    expect(Object.keys(result).sort()).toEqual(['clientName', 'name', 'status']);
    expect(result).not.toHaveProperty('projectName');
  });

  it('rejects a payload carrying a domain-owned field', () => {
    expect(() => createProject.transform({ projectName: 'Acme', status: 'approved' })).toThrow(
      ValidationFailedException,
    );
  });

  it('never lets a client-supplied value reach a domain-owned field', () => {
    // Even under the permissive strip policy, the mapping is what decides.
    const permissive = createRequestMapper(
      createProjectSchema,
      (input): CreateProjectCommand => ({
        name: input.projectName,
        clientName: input.clientName ?? null,
        status: 'draft',
      }),
      { unknownKeys: 'strip' },
    );

    const result = permissive.transform({
      projectName: 'Acme',
      status: 'approved',
      isApproved: true,
      ownerId: 'attacker',
    });

    expect(result.status).toBe('draft');
    expect(result).not.toHaveProperty('isApproved');
    expect(result).not.toHaveProperty('ownerId');
  });

  it('rejects an invalid payload before the mapping runs', () => {
    // Typed so the mock's `any` return does not leak into the mapper's generics.
    const map = jest.fn<CreateProjectCommand, [unknown]>();
    const mapper = createRequestMapper(createProjectSchema, map);

    expect(() => mapper.transform({ projectName: '' })).toThrow(ValidationFailedException);
    expect(map).not.toHaveBeenCalled();
  });

  it('rejects an unexpected nested property before the mapping runs', () => {
    const nested = createRequestMapper(
      z.object({ timeline: z.object({ durationDays: z.number().int().positive() }) }),
      (input) => ({ days: input.timeline.durationDays }),
    );

    expect(() => nested.transform({ timeline: { durationDays: 30, isLocked: true } })).toThrow(
      ValidationFailedException,
    );
  });
});
