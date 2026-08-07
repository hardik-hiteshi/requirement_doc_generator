import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ModelProfile } from '@wdrg/contracts';

import {
  InferenceError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResponse,
  type ProviderHealth,
} from './inference.types';

/**
 * A provider that returns fixtures instead of calling a model.
 *
 * It exists so business logic can be tested without inference. The state
 * machine, the chunking, the validation, the approval blockers and the whole
 * browser suite are about *this application*, and testing them against a real
 * model would make them slow, non-deterministic, and dependent on which weights
 * happened to be installed.
 *
 * **Rejected at startup in production.** A test double producing a requirement
 * baseline would be a baseline made of nothing, presented with the same
 * confidence as a real one — see `production-policy.ts`.
 *
 * Determinism comes from hashing the request rather than from a counter, so the
 * same input yields the same output regardless of order or parallelism. A
 * counter would make a test's result depend on what ran before it, which is
 * exactly the flakiness a fake provider is supposed to remove.
 */
@Injectable()
export class DeterministicProvider implements InferenceProvider {
  readonly name = 'deterministic';

  /** Fixture responses, keyed by scenario. Registered by tests. */
  private readonly fixtures = new Map<string, string>();

  /** Scenarios that should fail, and how. Registered by tests. */
  private readonly failures = new Map<string, InferenceError>();

  /** Every request made, so a test can assert on what was sent. */
  private readonly calls: InferenceRequest[] = [];

  /**
   * Registers the response for a task.
   *
   * Keyed by task id and an optional discriminator, so one test can drive a
   * multi-stage run with a different fixture per stage.
   */
  register(taskId: string, response: string, discriminator = ''): void {
    this.fixtures.set(this.key(taskId, discriminator), response);
  }

  /** Registers a failure for a task, for the failure-path tests. */
  registerFailure(taskId: string, error: InferenceError, discriminator = ''): void {
    this.failures.set(this.key(taskId, discriminator), error);
  }

  reset(): void {
    this.fixtures.clear();
    this.failures.clear();
    this.calls.length = 0;
  }

  /** What was asked, in order. For asserting that evidence stayed separate. */
  get requests(): readonly InferenceRequest[] {
    return this.calls;
  }

  complete(request: InferenceRequest): Promise<InferenceResponse> {
    this.calls.push(request);

    const failure = this.failures.get(this.key(request.taskId, ''));

    if (failure) {
      return Promise.reject(failure);
    }

    const fixture = this.fixtures.get(this.key(request.taskId, ''));

    if (fixture === undefined) {
      // Loud rather than empty. A test that forgot to register a fixture should
      // say so, not silently receive `{}` and assert against nothing.
      return Promise.reject(
        new InferenceError(
          'provider_unavailable',
          `No deterministic fixture registered for task "${request.taskId}". Register one with DeterministicProvider.register().`,
        ),
      );
    }

    const promptLength = request.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );

    return Promise.resolve({
      content: fixture,
      usage: {
        // Derived from the real input, so a test can assert that budgeting and
        // chunking used what they were supposed to.
        inputTokens: Math.ceil(promptLength / 3),
        outputTokens: Math.ceil(fixture.length / 3),
        cachedInputTokens: 0,
        // Fixed: a duration that varied would make snapshots and assertions
        // non-deterministic for no benefit.
        durationMs: 1,
      },
      model: 'deterministic-fixtures',
      provider: this.name,
      truncated: false,
    });
  }

  health(_profile: ModelProfile, _model: string): Promise<ProviderHealth> {
    return Promise.resolve({
      available: true,
      provider: this.name,
      detail: 'Deterministic test provider. Returns fixtures, and analyses nothing.',
    });
  }

  /** Stable across runs and machines. */
  private key(taskId: string, discriminator: string): string {
    return createHash('sha256').update(`${taskId}::${discriminator}`).digest('hex').slice(0, 32);
  }
}
