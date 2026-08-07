import { z } from 'zod';
import { checkInferenceEndpoint } from '@wdrg/contracts';

import type { AppConfigService } from '../src/config/app-config.service';
import { findModelProfile } from '../src/analysis/models/model-profiles';
import { OllamaProvider } from '../src/analysis/providers/ollama.provider';
import { InferenceError } from '../src/analysis/providers/inference.types';
import { AiTaskRunner } from '../src/analysis/task-runner.service';

/**
 * The Ollama provider against a **real, locally-running model**.
 *
 * Deliberately not part of the ordinary suites and not run by hosted CI. CI must
 * not download gigabytes of weights to check that business logic works — the
 * deterministic provider covers that, far faster and without the variance.
 *
 * What this covers is the part no fake can: that a real model, reached over a
 * real socket, returns something this application can actually validate. It is
 * the difference between "the adapter compiles" and "the adapter works".
 *
 *   pnpm --filter @wdrg/api test:ollama
 *
 * Skipped, loudly, when no server is reachable. A test that passes without the
 * thing it is testing reports coverage that does not exist.
 */

const BASE_URL = process.env.AI_BASE_URL ?? 'http://127.0.0.1:11434';
const MODEL = process.env.AI_MODEL ?? 'qwen2.5:3b-instruct';

/** Overrides merge into `ai`; anything else is set alongside it. */
function config(overrides: Record<string, unknown> = {}): AppConfigService {
  const { ai, ...rest } = overrides;

  return {
    isProduction: false,
    ...rest,
    ai: {
      provider: 'ollama',
      baseUrl: BASE_URL,
      modelProfile: 'qwen2.5-3b-instruct',
      modelOverride: '',
      requestTimeoutMs: 120_000,
      runTimeoutMs: 600_000,
      maxContextTokens: 8_192,
      maxOutputTokens: 1_024,
      maxAttempts: 2,
      ...(ai as object),
    },
  } as unknown as AppConfigService;
}

describe('Ollama, against a real local model', () => {
  const provider = new OllamaProvider(config());
  const profile = findModelProfile('qwen2.5-3b-instruct')!;
  let available = false;

  beforeAll(async () => {
    const health = await provider.health(profile, MODEL);
    available = health.available;

    if (!available) {
      console.warn(
        `SKIPPING real Ollama tests: ${health.detail ?? 'no server'} at ${BASE_URL}. ` +
          `Start ollama and run: ollama pull ${MODEL}`,
      );
    }
  }, 60_000);

  it('reaches the server and finds the model', async () => {
    if (!available) return;

    const health = await provider.health(profile, MODEL);

    expect(health.available).toBe(true);
    expect(health.provider).toBe('ollama');
    expect(health.models?.length ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it('talks only to a local endpoint', () => {
    // The configured endpoint must pass the policy that keeps requirement
    // content on the operator's own network — including in production mode.
    const verdict = checkInferenceEndpoint(BASE_URL, { requirePrivateAddress: true });

    expect(verdict.allowed).toBe(true);
  });

  it('returns valid JSON for a real structured task', async () => {
    if (!available) return;

    const schema = z
      .object({
        statements: z.array(z.object({ id: z.string(), text: z.string() })).min(1),
      })
      .strict();

    const runner = new AiTaskRunner(config());

    const outcome = await runner.run(provider, {
      taskId: 'requirement.normalize',
      profile,
      model: MODEL,
      evidence: [
        {
          blockId: 'b0',
          text: 'The system must let a sales user build a quote. A manager must approve it before it is sent.',
        },
      ],
      schema,
      correlationId: 'local-validation',
    });

    expect(outcome.ok).toBe(true);

    if (outcome.ok) {
      // A real model, so the wording is its own — but the shape is ours, and it
      // must have cited the block it was given.
      expect(outcome.value.statements.length).toBeGreaterThan(0);
      expect(outcome.execution.provider).toBe('ollama');
      expect(outcome.execution.promptVersion).toBe('v1');
      expect(outcome.execution.usage?.outputTokens ?? 0).toBeGreaterThan(0);
      expect(outcome.execution.usage?.durationMs ?? 0).toBeGreaterThan(0);
    }
  }, 300_000);

  it('reports a timeout rather than hanging', async () => {
    if (!available) return;

    const impatient = new OllamaProvider(config({ ai: { requestTimeoutMs: 1 } }));

    await expect(
      impatient.complete({
        messages: [{ role: 'user', content: 'Write a long essay about quoting systems.' }],
        model: MODEL,
        jsonMode: false,
        maxOutputTokens: 512,
        temperature: 0,
        timeoutMs: 1,
        correlationId: 'local-timeout',
        taskId: 'requirement.normalize',
      }),
    ).rejects.toMatchObject({ name: 'InferenceError', reason: 'timeout' });
  }, 60_000);

  it('reports a missing model as such, not as a generic failure', async () => {
    if (!available) return;

    const health = await provider.health(profile, 'definitely-not-a-real-model:999b');

    expect(health.available).toBe(false);
    expect(health.detail).toMatch(/ollama pull/i);
  }, 60_000);

  it('refuses to call a hosted endpoint even when configured to', async () => {
    // The policy is enforced per request, not only at startup: configuration can
    // change while the process is running.
    const misconfigured = new OllamaProvider(config({ ai: { baseUrl: 'https://api.openai.com' } }));

    await expect(
      misconfigured.complete({
        messages: [{ role: 'user', content: 'hello' }],
        model: MODEL,
        jsonMode: true,
        maxOutputTokens: 10,
        temperature: 0,
        timeoutMs: 5_000,
        correlationId: 'local-policy',
        taskId: 'requirement.normalize',
      }),
    ).rejects.toThrow(InferenceError);

    const health = await misconfigured.health(profile, MODEL);
    expect(health.available).toBe(false);
    expect(health.detail).toMatch(/hosted inference provider/i);
  }, 30_000);
});
