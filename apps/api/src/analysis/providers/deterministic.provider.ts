import { createHash } from 'node:crypto';

import { Injectable, Optional } from '@nestjs/common';
import type { ModelProfile } from '@wdrg/contracts';

import { AppConfigService } from '../../config/app-config.service';
import { echoResponse } from './echo-scenario';
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

  /**
   * Scripted responses for a task, consumed in order.
   *
   * For a multi-chunk run, where the same task is called once per chunk. Order
   * dependence would normally be a flakiness source; here it is not, because
   * the pipeline processes chunks in a sequential loop by construction — "the
   * second `requirement.normalize` call is chunk two" is a fact about the code,
   * not a race. When the script runs out, the last response repeats.
   */
  private readonly sequences = new Map<string, string[]>();
  private readonly consumed = new Map<string, number>();

  /** Scenarios that should fail, and how. Registered by tests. */
  private readonly failures = new Map<string, InferenceError>();

  /** Every request made, so a test can assert on what was sent. */
  private readonly calls: InferenceRequest[] = [];

  /**
   * Optional, so a unit test can construct this with `new` and no container.
   *
   * A test that builds it directly registers its own fixtures, which is what a
   * unit test should do; the scenario exists for the browser suite, where the
   * API is a separate process.
   */
  constructor(@Optional() private readonly config?: AppConfigService) {}

  /**
   * Registers the response for a task.
   *
   * Keyed by task id and an optional discriminator, so one test can drive a
   * multi-stage run with a different fixture per stage.
   */
  register(taskId: string, response: string, discriminator = ''): void {
    this.fixtures.set(this.key(taskId, discriminator), response);
  }

  /** Registers responses for a task, returned one per call, in order. */
  registerSequence(taskId: string, responses: readonly string[]): void {
    this.sequences.set(taskId, [...responses]);
    this.consumed.set(taskId, 0);
  }

  /** Registers a failure for a task, for the failure-path tests. */
  registerFailure(taskId: string, error: InferenceError, discriminator = ''): void {
    this.failures.set(this.key(taskId, discriminator), error);
  }

  reset(): void {
    this.fixtures.clear();
    this.sequences.clear();
    this.consumed.clear();
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

    const scripted = this.sequences.get(request.taskId);
    let fixture = this.fixtures.get(this.key(request.taskId, ''));

    if (scripted && scripted.length > 0) {
      const index = Math.min(this.consumed.get(request.taskId) ?? 0, scripted.length - 1);

      this.consumed.set(request.taskId, index + 1);
      fixture = scripted[index];
    }

    if (fixture === undefined) {
      /*
       * No fixture. Before failing, try the echo scenario — the browser suite
       * runs the API in a separate process and cannot register fixtures, so it
       * needs a stub that answers from the evidence it was given. See
       * `echo-scenario.ts` for what it does and does not invent.
       */
      const echoed =
        this.config?.ai.deterministicScenario === 'echo' ? echoResponse(request) : null;

      if (echoed !== null) {
        return Promise.resolve(this.respond(echoed, request));
      }

      // Loud rather than empty. A test that forgot to register a fixture should
      // say so, not silently receive `{}` and assert against nothing.
      return Promise.reject(
        new InferenceError(
          'provider_unavailable',
          `No deterministic fixture registered for task "${request.taskId}". Register one with DeterministicProvider.register().`,
        ),
      );
    }

    return Promise.resolve(this.respond(fixture, request));
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

  /** Builds a response envelope around a fixture body. */
  private respond(body: string, request: InferenceRequest): InferenceResponse {
    const promptLength = request.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );

    return {
      content: body,
      usage: {
        // Derived from the real input, so a test can assert that budgeting and
        // chunking used what they were supposed to.
        inputTokens: Math.ceil(promptLength / 3),
        outputTokens: Math.ceil(body.length / 3),
        cachedInputTokens: 0,
        // Fixed: a duration that varied would make snapshots and assertions
        // non-deterministic for no benefit.
        durationMs: 1,
      },
      model: 'deterministic-fixtures',
      provider: this.name,
      truncated: false,
    };
  }
}
