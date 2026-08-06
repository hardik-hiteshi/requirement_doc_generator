import { z } from 'zod';

import { ValidationFailedException } from '../errors/app.exception';
import { ZodValidationPipe } from './zod-validation.pipe';

const schema = z.object({
  projectName: z.string().min(1),
  clientName: z.string().optional(),
  timeline: z
    .object({
      durationDays: z.number().int().positive(),
    })
    .optional(),
});

describe('ZodValidationPipe', () => {
  describe('valid input', () => {
    const pipe = new ZodValidationPipe(schema);

    it('returns the parsed value', () => {
      expect(pipe.transform({ projectName: 'Acme portal' })).toEqual({
        projectName: 'Acme portal',
      });
    });

    it('preserves nested declared properties', () => {
      expect(pipe.transform({ projectName: 'Acme', timeline: { durationDays: 30 } })).toEqual({
        projectName: 'Acme',
        timeline: { durationDays: 30 },
      });
    });
  });

  describe('unknown properties — default reject policy', () => {
    const pipe = new ZodValidationPipe(schema);

    it('rejects an unexpected top-level property', () => {
      expect(() => pipe.transform({ projectName: 'Acme', isApproved: true })).toThrow(
        ValidationFailedException,
      );
    });

    it('names the offending key so the caller can fix the request', () => {
      try {
        pipe.transform({ projectName: 'Acme', isApproved: true });
        throw new Error('expected validation to fail');
      } catch (error) {
        const details = (error as ValidationFailedException).details ?? [];
        expect(JSON.stringify(details)).toContain('isApproved');
      }
    });

    it('rejects an unexpected NESTED property', () => {
      expect(() =>
        pipe.transform({
          projectName: 'Acme',
          timeline: { durationDays: 30, isLocked: true },
        }),
      ).toThrow(ValidationFailedException);
    });

    it('rejects several unexpected properties in one pass', () => {
      try {
        pipe.transform({ projectName: 'Acme', role: 'admin', ownerId: 'x', tier: 'free' });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect((error as ValidationFailedException).details?.length).toBeGreaterThan(0);
      }
    });

    it.each(['__proto__', 'constructor', 'prototype'])(
      'rejects the prototype-pollution key %s',
      (key) => {
        expect(() =>
          pipe.transform(JSON.parse(`{"projectName":"Acme","${key}":{"admin":true}}`)),
        ).toThrow(ValidationFailedException);
      },
    );

    it('reports a 422 so the client can distinguish it from a server fault', () => {
      try {
        pipe.transform({ projectName: 'Acme', unexpected: 1 });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect((error as ValidationFailedException).getStatus()).toBe(422);
      }
    });
  });

  describe('unknown properties — explicit strip policy', () => {
    const pipe = new ZodValidationPipe(schema, { unknownKeys: 'strip' });

    it('drops an unexpected top-level property instead of failing', () => {
      const result = pipe.transform({ projectName: 'Acme', isApproved: true, role: 'admin' });

      expect(result).toEqual({ projectName: 'Acme' });
      expect(result).not.toHaveProperty('isApproved');
      expect(result).not.toHaveProperty('role');
    });

    it('drops an unexpected nested property', () => {
      const result = pipe.transform({
        projectName: 'Acme',
        timeline: { durationDays: 30, isLocked: true },
      });

      expect(result).toEqual({ projectName: 'Acme', timeline: { durationDays: 30 } });
    });
  });

  describe('field validation', () => {
    const pipe = new ZodValidationPipe(schema);

    it('reports the offending path', () => {
      try {
        pipe.transform({ projectName: '' });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect((error as ValidationFailedException).details?.[0]?.path).toBe('projectName');
      }
    });

    it('reports a nested path in full', () => {
      try {
        pipe.transform({ projectName: 'Acme', timeline: { durationDays: -1 } });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect((error as ValidationFailedException).details?.[0]?.path).toBe(
          'timeline.durationDays',
        );
      }
    });

    it('reports every problem in one pass', () => {
      const strict = new ZodValidationPipe(
        z.object({ a: z.string(), b: z.number(), c: z.boolean() }),
      );

      try {
        strict.transform({});
        throw new Error('expected validation to fail');
      } catch (error) {
        expect((error as ValidationFailedException).details).toHaveLength(3);
      }
    });
  });

  describe('non-object schemas', () => {
    it('passes through unchanged', () => {
      expect(new ZodValidationPipe(z.array(z.string())).transform(['a', 'b'])).toEqual(['a', 'b']);
    });
  });
});
