import { getPrompt, formatEvidence } from '../prompts/prompt-registry';
import { echoResponse } from './echo-scenario';
import type { InferenceRequest } from './inference.types';

/**
 * The stub that lets the browser suite run without a model.
 *
 * Tested because it is load-bearing for the browser suite, and because its one
 * bug so far — reading the *system* prompt's mention of the evidence delimiters
 * instead of the evidence — produced an analysis that ran, succeeded and
 * returned nothing. A silent empty result is the hardest kind to notice.
 */
function request(taskId: InferenceRequest['taskId'], blocks: { blockId: string; text: string }[]) {
  return {
    // The real system prompt, which names both delimiters.
    messages: [
      { role: 'system' as const, content: getPrompt(taskId).system },
      { role: 'user' as const, content: formatEvidence(blocks) },
    ],
    model: 'deterministic',
    jsonMode: true,
    maxOutputTokens: 512,
    temperature: 0,
    timeoutMs: 1_000,
    correlationId: 'echo-test',
    taskId,
  };
}

const BLOCKS = [
  { blockId: 'b0', text: 'The system must let a sales user build a quote.' },
  { blockId: 'b1', text: 'A manager must approve every quote before it is sent.' },
  { blockId: 'b2', text: 'Page 3 of 8' },
];

describe('the echo scenario', () => {
  it('reads the evidence, not the prompt that describes it', () => {
    const output = JSON.parse(echoResponse(request('requirement.normalize', BLOCKS)) ?? '{}');

    expect(output.statements).toHaveLength(3);
    expect(output.statements[0].blockIds).toEqual(['b0']);
  });

  it('quotes each block verbatim, so verification has something real to check', () => {
    const output = JSON.parse(echoResponse(request('requirement.extract', BLOCKS)) ?? '{}');

    expect(output.items).toHaveLength(2);
    expect(output.items[0].evidence[0]).toEqual({
      blockId: 'b0',
      excerpt: 'The system must let a sales user build a quote.',
    });
  });

  it('accounts for page furniture rather than ignoring it', () => {
    // Coverage counts decisions, so "no requirement here" has to be reported.
    const output = JSON.parse(echoResponse(request('requirement.extract', BLOCKS)) ?? '{}');

    expect(output.nonRequirementBlocks).toEqual([
      { blockId: 'b2', reason: 'This line does not state a requirement.' },
    ]);
  });

  it('invents no findings', () => {
    // A stub producing a fabricated conflict would put fiction in front of a
    // reviewer, which is the failure the whole phase exists to prevent.
    for (const task of ['requirement.conflicts', 'requirement.duplicates'] as const) {
      const output = JSON.parse(echoResponse(request(task, BLOCKS)) ?? '{}');

      expect(output.conflicts ?? output.groups).toEqual([]);
    }
  });

  it('asks about an unqualified "users", and nothing else', () => {
    // Mechanical rather than a judgement: it fires only where the evidence
    // literally contains the word, which is what keeps it a transformation of
    // the input rather than an invention about it.
    const asked = JSON.parse(
      echoResponse(
        request('clarification.generate', [{ blockId: 'b0', text: 'Users can approve requests.' }]),
      ) ?? '{}',
    );

    expect(asked.questions).toHaveLength(1);
    expect(asked.questions[0].impact).toBe('BLOCKING');

    const silent = JSON.parse(
      echoResponse(
        request('clarification.generate', [
          { blockId: 'b0', text: 'The system must send a quote within 24 hours.' },
        ]),
      ) ?? '{}',
    );

    expect(silent.questions).toEqual([]);
  });

  it('joins a confirmed answer onto the requirement it qualifies', () => {
    const output = JSON.parse(
      echoResponse(
        request('clarification.integrate', [
          {
            blockId: 'Q-001',
            text: 'Question: Which users?\nConfirmed answer: Only Project Managers.',
          },
          { blockId: 'req_1', text: '[REQ-001] (functional) Approve: Users can approve requests.' },
        ]),
      ) ?? '{}',
    );

    expect(output.updates).toHaveLength(1);
    expect(output.updates[0].itemId).toBe('req_1');
    expect(output.updates[0].description).toContain('Only Project Managers.');
    // Never invents a requirement: one created here would arrive in a baseline
    // as though the client had asked for it.
    expect(output.newRequirements).toEqual([]);
  });

  it('returns nothing when there is no evidence to echo', () => {
    const output = JSON.parse(echoResponse(request('requirement.normalize', [])) ?? '{}');

    expect(output.statements).toEqual([]);
  });
});
