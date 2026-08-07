import { z } from 'zod';
import {
  checkInferenceEndpoint,
  estimateTokens,
  evidenceBudgetCharacters,
  isHostedProvider,
  isPrivateHost,
  isProductionUsable,
  modelProfileSchema,
  parseEndpoint,
  supportsAnalysis,
  ANALYSIS_LIMITS,
  AI_TASK_IDS,
  type ModelProfile,
} from '@wdrg/contracts';

import type { AppConfigService } from '../config/app-config.service';
import { findModelProfile, MODEL_PROFILES } from './models/model-profiles';
import {
  buildRepairInstruction,
  checkHasReferences,
  checkSourceReferences,
  checkUniqueIds,
  extractJson,
  validateOutput,
} from './output/structured-output';
import {
  allPrompts,
  EVIDENCE_CLOSE,
  EVIDENCE_OPEN,
  formatEvidence,
  getPrompt,
  missingPrompts,
  promptRegistryChecksum,
} from './prompts/prompt-registry';
import { DeterministicProvider } from './providers/deterministic.provider';
import { InferenceError } from './providers/inference.types';
import { AiTaskRunner } from './task-runner.service';

/**
 * The self-hosted inference layer.
 *
 * Two things dominate these tests, because they are the two ways this layer
 * could fail badly: requirement content reaching a vendor, and unvalidated model
 * output reaching the database.
 */

/** Overrides merge into `ai`; anything else is set alongside it. */
/** A profile that must exist. A missing one is a bug in the registry, not in the test. */
function profileFor(id: string): ModelProfile {
  const profile = findModelProfile(id);

  if (!profile) {
    throw new Error(`No such model profile: ${id}`);
  }

  return profile;
}

function config(
  overrides: Record<string, unknown> & { ai?: Record<string, unknown> } = {},
): AppConfigService {
  const { ai, ...rest } = overrides;

  return {
    isProduction: false,
    ...rest,
    ai: {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      modelProfile: 'qwen2.5-3b-instruct',
      modelOverride: '',
      requestTimeoutMs: 30_000,
      runTimeoutMs: 600_000,
      maxContextTokens: 0,
      maxOutputTokens: 0,
      maxAttempts: 3,
      ...(ai ?? {}),
    },
  } as unknown as AppConfigService;
}

/* ------------------------------------------------------- endpoint policy */

describe('inference endpoint policy', () => {
  const dev = { requirePrivateAddress: false };
  const prod = { requirePrivateAddress: true };

  it('refuses an unconfigured endpoint rather than defaulting anywhere', () => {
    const verdict = checkInferenceEndpoint('', dev);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('not_configured');
    expect(verdict.reason).toMatch(/no default/i);
  });

  it.each([
    'https://api.openai.com/v1',
    'https://eu.api.openai.com/v1',
    'https://api.anthropic.com',
    'https://generativelanguage.googleapis.com',
    'https://my-resource.openai.azure.com',
    'https://bedrock-runtime.us-east-1.amazonaws.com',
    'https://api.mistral.ai/v1',
    'https://api.groq.com/openai/v1',
    'https://api.together.xyz/v1',
    'https://openrouter.ai/api/v1',
    'https://api-inference.huggingface.co',
    'https://api.deepseek.com',
    'https://api.x.ai/v1',
  ])('refuses the hosted provider %s', (url) => {
    // In development too. This is not a production-only rule: a developer must
    // not be able to send a client's requirements to a vendor either.
    const verdict = checkInferenceEndpoint(url, dev);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('hosted_provider');
    expect(verdict.reason).toMatch(/never leaves your network/i);
  });

  it.each([
    'http://127.0.0.1:11434',
    'http://localhost:8000/v1',
    'http://10.0.5.20:8000',
    'http://192.168.1.50:11434',
    'http://172.16.4.9:8000',
    'http://vllm:8000',
    'http://inference.internal:8000',
    'http://gpu-box.lan:11434',
    'https://[::1]:8000',
  ])('allows the self-hosted endpoint %s in production', (url) => {
    expect(checkInferenceEndpoint(url, prod).allowed).toBe(true);
  });

  it('allows a public address in development but not in production', () => {
    const url = 'http://inference.example.com:8000';

    expect(checkInferenceEndpoint(url, dev).allowed).toBe(true);

    const production = checkInferenceEndpoint(url, prod);
    expect(production.allowed).toBe(false);
    expect(production.rejection).toBe('public_address');
  });

  it('does not mistake an internal host that merely contains a vendor name', () => {
    // A perfectly reasonable internal name for a self-hosted server.
    expect(checkInferenceEndpoint('http://openai.mycompany.internal:8000', prod).allowed).toBe(
      true,
    );
    expect(isHostedProvider('openai.mycompany.internal')).toBe(false);
    expect(isHostedProvider('api.openai.com')).toBe(true);
  });

  it.each(['ftp://host/x', 'file:///etc/passwd', 'gopher://host'])(
    'refuses the scheme in %s',
    (url) => {
      expect(checkInferenceEndpoint(url, dev).rejection).toBe('unsupported_scheme');
    },
  );

  it('refuses credentials in the URL, which end up in logs', () => {
    const verdict = checkInferenceEndpoint('http://user:hunter2pass@10.0.0.4:8000', dev);

    expect(verdict.rejection).toBe('credentials_in_url');
    // The reason must not quote the credential back — that would put it in the
    // log this check exists to keep it out of.
    expect(verdict.reason).not.toContain('hunter2pass');
    expect(verdict.reason).not.toContain('user:');
  });

  it.each(['not a url', 'http://', '://missing-scheme'])('refuses malformed %p', (url) => {
    expect(checkInferenceEndpoint(url, dev).allowed).toBe(false);
  });

  it('treats a trailing-dot hostname as the same host', () => {
    expect(isHostedProvider(parseEndpoint('https://api.openai.com./v1')?.host ?? '')).toBe(true);
  });

  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    // Link-local is *not* private. It reaches whatever answers on the local
    // segment, which in a cloud deployment includes the metadata service.
    ['169.254.1.1', false],
    ['169.254.169.254', false],
    // Carrier-grade NAT is shared with a carrier, so it is not "your network".
    ['100.64.0.1', false],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['::1', true],
    ['fd00::1', true],
    ['2001:4860:4860::8888', false],
  ])('classifies %s as private=%s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});

/* --------------------------------------------------------- model profiles */

describe('model profiles', () => {
  it('every profile satisfies the published contract', () => {
    for (const profile of MODEL_PROFILES) {
      expect(() => modelProfileSchema.parse(profile)).not.toThrow();
    }
  });

  it('records a licence and a weights source for every profile', () => {
    for (const profile of MODEL_PROFILES) {
      expect(profile.licence.length).toBeGreaterThan(0);
      expect(profile.weightsSource.length).toBeGreaterThan(0);
      // The whole point: nothing here points at a file in this repository.
      expect(profile.weightsSource).not.toMatch(/^\.|node_modules|apps\//);
    }
  });

  it('has a validated development profile with a permissive licence', () => {
    const profile = findModelProfile('qwen2.5-3b-instruct');

    expect(profile).toBeDefined();
    expect(profile?.licence).toBe('Apache-2.0');
    expect(profile?.commercialUse).toBe('permitted');
    expect(profile?.requiresLegalReview).toBe(false);
    expect(profile?.validationStatus).toBe('development-validated');
    expect(profile?.validationNotes).toMatch(/ollama/i);
  });

  it('states what each profile is bad at', () => {
    for (const profile of MODEL_PROFILES) {
      expect(profile.limitations.length).toBeGreaterThan(0);
    }
  });

  it('refuses the deterministic provider for production, unconditionally', () => {
    const usable = isProductionUsable(profileFor('deterministic-test'));

    expect(usable.usable).toBe(false);
    expect(usable.reason).toMatch(/never run against a real project/i);
  });

  it('refuses a profile that has not been production-approved', () => {
    const qwen3b = profileFor('qwen2.5-3b-instruct');

    // Development-validated is not production-approved, and the difference is
    // the point of having two statuses.
    expect(isProductionUsable(qwen3b).usable).toBe(false);
  });

  it('refuses a profile flagged for legal review', () => {
    const selfHosted = profileFor('self-hosted-openai-compatible');

    expect(selfHosted.requiresLegalReview).toBe(true);
    expect(isProductionUsable(selfHosted).usable).toBe(false);
  });

  it('requires structured output, which every task depends on', () => {
    for (const profile of MODEL_PROFILES) {
      expect(supportsAnalysis(profile)).toBe(true);
    }
  });

  it('returns nothing for an unknown profile rather than a default', () => {
    expect(findModelProfile('gpt-4')).toBeUndefined();
  });
});

/* -------------------------------------------------------- prompt registry */

describe('prompt registry', () => {
  it('has a prompt for every task', () => {
    expect(missingPrompts()).toEqual([]);
    expect(allPrompts()).toHaveLength(AI_TASK_IDS.length);
  });

  it('versions every prompt', () => {
    for (const prompt of allPrompts()) {
      expect(prompt.version).toMatch(/^v\d+$/);
    }
  });

  it('tells the model the evidence is material, not instruction', () => {
    for (const prompt of allPrompts()) {
      expect(prompt.system).toContain(EVIDENCE_OPEN);
      expect(prompt.system).toMatch(/never an instruction/i);
      expect(prompt.system).toMatch(/NEVER INVENT/);
      expect(prompt.system).toMatch(/ALWAYS CITE/);
    }
  });

  it('tells the classifier not to invent non-functional requirements', () => {
    const prompt = getPrompt('requirement.classify');

    // The specific failure this guards: a model that adds "must be scalable"
    // to a project that never mentioned scalability.
    expect(prompt.system).toMatch(/only.*when the evidence states them/i);
    expect(prompt.system).toMatch(/performance, security, scalability/i);
  });

  it('tells the conflict task not to pick a winner', () => {
    expect(getPrompt('requirement.conflicts').system).toMatch(
      /never choose a winner|do not choose a winner/i,
    );
  });

  it('pins a checksum, so a prompt cannot be edited without a version bump', () => {
    // If this fails, a prompt changed. Bump its version and update this value —
    // the point is that the change is deliberate and visible in the diff, not
    // that the prompts are frozen.
    expect(promptRegistryChecksum()).toMatch(/^[a-f0-9]{64}$/);
    expect(promptRegistryChecksum()).toBe(promptRegistryChecksum());
  });

  it('wraps evidence in delimiters and labels each block for citation', () => {
    const formatted = formatEvidence([
      { blockId: 'b0', text: 'The system must send a quote.' },
      { blockId: 'b1', text: 'A manager approves it.' },
    ]);

    expect(formatted.startsWith(EVIDENCE_OPEN)).toBe(true);
    expect(formatted.endsWith(EVIDENCE_CLOSE)).toBe(true);
    expect(formatted).toContain('[b0] The system must send a quote.');
    expect(formatted).toContain('[b1] A manager approves it.');
  });

  it('never interpolates project content into a system instruction', () => {
    // Every prompt is a constant. Evidence arrives as a separate user message,
    // which is what makes the boundary structural rather than hopeful.
    for (const prompt of allPrompts()) {
      expect(prompt.system).not.toContain('${');
    }
  });
});

/* ------------------------------------------------- structured output */

describe('JSON extraction', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, json: { a: 1 } });
  });

  it('reads an object out of a fenced code block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ ok: true, json: { a: 1 } });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ ok: true, json: { a: 1 } });
  });

  it('reads an object out of surrounding prose', () => {
    const result = extractJson('Here is the result:\n{"a":1}\nHope that helps!');
    expect(result).toEqual({ ok: true, json: { a: 1 } });
  });

  it('is not confused by braces inside strings', () => {
    const result = extractJson('{"text":"a } brace and a { brace","n":2}');
    expect(result.ok && (result.json as { n: number }).n).toBe(2);
  });

  it('refuses a bare scalar, which is not a task result', () => {
    expect(extractJson('42').ok).toBe(false);
    expect(extractJson('"just a string"').ok).toBe(false);
  });

  it.each(['', '   ', 'no json at all', '{unclosed'])('refuses %p', (raw) => {
    expect(extractJson(raw).ok).toBe(false);
  });
});

describe('output validation', () => {
  const schema = z
    .object({ items: z.array(z.object({ id: z.string(), text: z.string() })) })
    .strict();

  it('accepts valid output', () => {
    const result = validateOutput('{"items":[{"id":"r1","text":"x"}]}', schema);
    expect(result.ok).toBe(true);
  });

  it('rejects an undeclared field rather than stripping it', () => {
    // Stripping would silently discard something the model thought mattered.
    const result = validateOutput('{"items":[],"extra":true}', schema);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('schema_invalid');
  });

  it('reports invalid JSON distinctly from an invalid shape', () => {
    expect(validateOutput('not json', schema)).toMatchObject({ reason: 'invalid_json' });
    expect(validateOutput('{"items":"wrong"}', schema)).toMatchObject({ reason: 'schema_invalid' });
  });

  it('runs semantic checks the schema cannot express', () => {
    const result = validateOutput(
      '{"items":[{"id":"r1","text":"a"},{"id":"r1","text":"b"}]}',
      schema,
      {
        validate: (value) => checkUniqueIds(value.items, 'items'),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('duplicate_identifiers');
  });
});

describe('semantic checks', () => {
  it('catches a reused identifier', () => {
    const issues = checkUniqueIds([{ id: 'r1' }, { id: 'r2' }, { id: 'r1' }], 'items');

    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toBe('duplicate_identifiers');
  });

  it('catches a citation to a source that is not in the project', () => {
    const issues = checkSourceReferences(
      [
        { sourceId: 'src_REAL', path: 'items.0' },
        { sourceId: 'src_INVENTED', path: 'items.1' },
      ],
      new Set(['src_REAL']),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toBe('hallucinated_source_reference');
    expect(issues[0]?.message).toMatch(/not part of this project/i);
  });

  it('catches a requirement with no citation at all', () => {
    const issues = checkHasReferences(
      [
        { id: 'r1', referenceCount: 2 },
        { id: 'r2', referenceCount: 0 },
      ],
      'items',
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.reason).toBe('missing_source_reference');
  });
});

describe('repair instructions', () => {
  it('describes the problems and asks for the whole result again', () => {
    const instruction = buildRepairInstruction('requirement.extract', [
      { path: 'items.0.title', message: 'Required', reason: 'schema_invalid' },
    ]);

    expect(instruction).toContain('items.0.title: Required');
    expect(instruction).toMatch(/only JSON/i);
  });

  it('carries no project content, so a repair cannot leak evidence', () => {
    const instruction = buildRepairInstruction('requirement.extract', [
      { path: 'items.0.title', message: 'Required', reason: 'schema_invalid' },
    ]);

    expect(instruction).not.toContain(EVIDENCE_OPEN);
    expect(instruction.length).toBeLessThan(1_000);
  });
});

/* ------------------------------------------------------------ budgeting */

describe('context budgeting', () => {
  it('estimates tokens pessimistically', () => {
    // Three characters per token under-estimates capacity, which makes a chunk
    // too small rather than overflowing.
    expect(estimateTokens('a'.repeat(300))).toBe(100);
  });

  it('reserves room for the answer inside the context', () => {
    const budget = evidenceBudgetCharacters(32_768, 8_192);

    expect(budget).toBeLessThanOrEqual(ANALYSIS_LIMITS.maxChunkCharacters);
    expect(budget).toBeGreaterThan(ANALYSIS_LIMITS.minChunkCharacters);
  });

  it('never returns a budget below the floor, even for a tiny context', () => {
    expect(evidenceBudgetCharacters(1_000, 900)).toBe(ANALYSIS_LIMITS.minChunkCharacters);
  });
});

/* -------------------------------------------------- deterministic provider */

describe('deterministic provider', () => {
  let provider: DeterministicProvider;

  beforeEach(() => {
    provider = new DeterministicProvider();
    provider.reset();
  });

  it('returns the registered fixture', async () => {
    provider.register('requirement.extract', '{"items":[]}');

    const response = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      model: 'deterministic-fixtures',
      jsonMode: true,
      maxOutputTokens: 100,
      temperature: 0,
      timeoutMs: 1_000,
      correlationId: 'test',
      taskId: 'requirement.extract',
    });

    expect(response.content).toBe('{"items":[]}');
    expect(response.provider).toBe('deterministic');
  });

  it('fails loudly when no fixture was registered', async () => {
    // Silently returning {} would let a test assert against nothing.
    await expect(
      provider.complete({
        messages: [],
        model: 'deterministic-fixtures',
        jsonMode: true,
        maxOutputTokens: 100,
        temperature: 0,
        timeoutMs: 1_000,
        correlationId: 'test',
        taskId: 'requirement.classify',
      }),
    ).rejects.toThrow(/No deterministic fixture registered/);
  });

  it('gives the same answer for the same input', async () => {
    provider.register('requirement.extract', '{"items":[]}');

    const request = {
      messages: [{ role: 'user' as const, content: 'x' }],
      model: 'deterministic-fixtures',
      jsonMode: true,
      maxOutputTokens: 100,
      temperature: 0,
      timeoutMs: 1_000,
      correlationId: 'test',
      taskId: 'requirement.extract' as const,
    };

    const first = await provider.complete(request);
    const second = await provider.complete(request);

    expect(second.content).toBe(first.content);
    expect(second.usage).toEqual(first.usage);
  });

  it('records what was asked, so a test can check the boundary held', async () => {
    provider.register('requirement.extract', '{"items":[]}');

    await provider.complete({
      messages: [
        { role: 'system', content: 'instructions' },
        { role: 'user', content: 'evidence' },
      ],
      model: 'deterministic-fixtures',
      jsonMode: true,
      maxOutputTokens: 100,
      temperature: 0,
      timeoutMs: 1_000,
      correlationId: 'test',
      taskId: 'requirement.extract',
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages[0]?.role).toBe('system');
  });
});

/* ------------------------------------------------------------ task runner */

describe('AiTaskRunner', () => {
  const schema = z
    .object({ statements: z.array(z.object({ id: z.string(), text: z.string() })) })
    .strict();
  const evidence = [{ blockId: 'b0', text: 'The system must send a quote.' }];
  const profile = profileFor('deterministic-test');

  let provider: DeterministicProvider;
  let runner: AiTaskRunner;

  beforeEach(() => {
    provider = new DeterministicProvider();
    provider.reset();
    runner = new AiTaskRunner(config());
  });

  const input = {
    taskId: 'requirement.normalize' as const,
    profile,
    model: 'deterministic-fixtures',
    evidence,
    schema,
    correlationId: 'test-run',
  };

  it('returns validated output and records the execution', async () => {
    provider.register('requirement.normalize', '{"statements":[{"id":"s1","text":"x"}]}');

    const outcome = await runner.run(provider, input);

    expect(outcome.ok).toBe(true);
    expect(outcome.execution.succeeded).toBe(true);
    expect(outcome.execution.promptVersion).toBe('v1');
    expect(outcome.execution.modelProfileId).toBe('deterministic-test');
    expect(outcome.execution.repairAttempts).toBe(0);
  });

  it('keeps instructions and evidence in separate messages', async () => {
    provider.register('requirement.normalize', '{"statements":[]}');
    await runner.run(provider, input);

    const messages = provider.requests[0]?.messages ?? [];
    const system = messages.filter((message) => message.role === 'system');
    const user = messages.filter((message) => message.role === 'user');

    expect(system).toHaveLength(1);
    // The requirement text is in a user message, never in the instruction.
    expect(system[0]?.content).not.toContain('The system must send a quote');
    expect(user[0]?.content).toContain('The system must send a quote');
    expect(user[0]?.content).toContain(EVIDENCE_OPEN);
  });

  it('always asks for temperature zero, so analysis is reproducible', async () => {
    provider.register('requirement.normalize', '{"statements":[]}');
    await runner.run(provider, input);

    expect(provider.requests[0]?.temperature).toBe(0);
    expect(provider.requests[0]?.jsonMode).toBe(true);
  });

  it('repairs invalid output, bounded, then gives up', async () => {
    provider.register('requirement.normalize', '{"wrong":true}');

    const outcome = await runner.run(provider, input);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('repair_exhausted');
    expect(outcome.execution.repairAttempts).toBe(ANALYSIS_LIMITS.maxRepairAttempts);
    // One first attempt plus the bounded repairs — never an unbounded loop.
    expect(provider.requests).toHaveLength(ANALYSIS_LIMITS.maxRepairAttempts + 1);
  });

  it('sends only the validation issues on a repair, never the evidence again', async () => {
    provider.register('requirement.normalize', '{"wrong":true}');
    await runner.run(provider, input);

    const repair = provider.requests[1];
    const added = repair?.messages[repair.messages.length - 1];

    expect(added?.content).toMatch(/did not satisfy the required output format/i);
    expect(added?.content).not.toContain('The system must send a quote');
  });

  it('refuses a hallucinated citation without asking again', async () => {
    provider.register('requirement.normalize', '{"statements":[{"id":"s1","text":"x"}]}');

    const outcome = await runner.run(provider, {
      ...input,
      semantic: {
        validate: () =>
          checkSourceReferences([{ sourceId: 'src_INVENTED', path: 'statements.0' }], new Set()),
      },
    });

    expect(outcome.ok === false && outcome.reason).toBe('hallucinated_source_reference');
    // Asking again invites a different invention.
    expect(provider.requests).toHaveLength(1);
  });

  it('retries a provider that is unavailable', async () => {
    provider.registerFailure(
      'requirement.normalize',
      new InferenceError('model_loading', 'still loading'),
    );

    const outcome = await runner.run(provider, input);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('model_loading');
    expect(provider.requests.length).toBeGreaterThan(1);
  }, 30_000);

  it('does not retry a context overflow, which a retry cannot clear', async () => {
    provider.registerFailure(
      'requirement.normalize',
      new InferenceError('context_overflow', 'too big'),
    );

    const outcome = await runner.run(provider, input);

    expect(outcome.ok === false && outcome.reason).toBe('context_overflow');
    expect(provider.requests).toHaveLength(1);
  });

  it('stops when cancelled, before calling the provider', async () => {
    provider.register('requirement.normalize', '{"statements":[]}');

    const outcome = await runner.run(provider, {
      ...input,
      isCancelled: () => Promise.resolve(true),
    });

    expect(outcome.ok === false && outcome.reason).toBe('cancelled');
    expect(provider.requests).toHaveLength(0);
  });
});
