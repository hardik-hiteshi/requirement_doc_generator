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

  it('invents no findings and asks no questions', () => {
    // A stub producing a fabricated conflict would put fiction in front of a
    // reviewer, which is the failure the whole phase exists to prevent.
    for (const task of ['requirement.conflicts', 'requirement.duplicates'] as const) {
      const output = JSON.parse(echoResponse(request(task, BLOCKS)) ?? '{}');

      expect(output.conflicts ?? output.groups).toEqual([]);
    }

    const questions = JSON.parse(echoResponse(request('clarification.generate', BLOCKS)) ?? '{}');

    expect(questions.questions).toEqual([]);
  });

  it('returns nothing when there is no evidence to echo', () => {
    const output = JSON.parse(echoResponse(request('requirement.normalize', [])) ?? '{}');

    expect(output.statements).toEqual([]);
  });
});
