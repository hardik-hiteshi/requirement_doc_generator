import type { AiTaskId } from '@wdrg/contracts';

import type { DeterministicProvider } from '../src/analysis/providers/deterministic.provider';

/**
 * A scripted analysis, for tests that need a whole run without a model.
 *
 * These are what CI uses. Hosted CI must not download gigabytes of weights to
 * check that business logic works, and a real model would make every assertion
 * probabilistic — "usually finds the conflict" is not a test.
 *
 * The fixtures are written to exercise the *hard* cases rather than the happy
 * path, because those are the ones the application has to get right:
 *
 * - a requirement stated in one document and **contradicted in another**, which
 *   only cross-chunk reconciliation can surface;
 * - a **duplicate across two documents**, likewise;
 * - a **fabricated quotation** — the model citing words the document does not
 *   contain — so the verification path has something real to catch;
 * - a block the model reports as **holding no requirement**, so coverage has to
 *   count a decision rather than a silence.
 */

export interface FixtureSource {
  readonly title: string;
  readonly text: string;
}

/**
 * Two documents that disagree.
 *
 * `Brief` says quotes are approved by a manager; `Addendum` says they are sent
 * without approval. Chunked separately, neither contradicts itself.
 */
export const CONFLICTING_SOURCES: readonly FixtureSource[] = [
  {
    title: 'Client brief',
    text: [
      'The system must let a sales user build a quote.',
      'A manager must approve every quote before it is sent to the customer.',
      'Quotes must be sent within 24 hours.',
    ].join('\n'),
  },
  {
    title: 'Addendum',
    text: [
      'Quotes must be sent within 24 hours.',
      'Quotes are sent to the customer immediately, with no approval step.',
      'Page 3 of 8',
    ].join('\n'),
  },
];

/**
 * Registers a scripted run against the deterministic provider.
 *
 * Every task in the pipeline is answered, in the order the pipeline calls them:
 * three per chunk, then the cross-chunk stage. A task with no fixture makes the
 * provider throw loudly, so a pipeline change that adds a call fails visibly
 * rather than silently returning nothing.
 */
export function registerAnalysisFixtures(
  provider: DeterministicProvider,
  blockIds: { brief: string[]; addendum: string[] },
): void {
  provider.reset();

  const script = new Script();
  const respond = (taskId: AiTaskId, payload: unknown): void => script.add(taskId, payload);

  /* ------------------------------------------------ chunk 1: the brief */

  respond('requirement.normalize', {
    statements: [
      {
        id: 's1',
        text: 'The system must let a sales user build a quote.',
        blockIds: [blockIds.brief[0]],
      },
      {
        id: 's2',
        text: 'A manager must approve every quote before it is sent to the customer.',
        blockIds: [blockIds.brief[1]],
      },
      {
        id: 's3',
        text: 'Quotes must be sent within 24 hours.',
        blockIds: [blockIds.brief[2]],
      },
    ],
  });

  respond('requirement.classify', {
    classifications: [
      { statementId: 's1', category: 'FUNCTIONAL_REQUIREMENT', confidence: 0.9 },
      { statementId: 's2', category: 'BUSINESS_RULE', confidence: 0.85 },
      { statementId: 's3', category: 'NON_FUNCTIONAL_REQUIREMENT', confidence: 0.7 },
    ],
  });

  respond('requirement.extract', {
    items: [
      {
        id: 'r1',
        statementIds: ['s1'],
        category: 'FUNCTIONAL_REQUIREMENT',
        title: 'Build a quote',
        description: 'The system must let a sales user build a quote.',
        priority: 'MUST',
        evidence: [{ blockId: blockIds.brief[0], excerpt: 'must let a sales user build a quote' }],
        confidence: 0.9,
      },
      {
        id: 'r2',
        statementIds: ['s2'],
        category: 'BUSINESS_RULE',
        title: 'Manager approval',
        description: 'A manager must approve every quote before it is sent to the customer.',
        evidence: [{ blockId: blockIds.brief[1], excerpt: 'manager must approve every quote' }],
        confidence: 0.8,
      },
      {
        id: 'r3',
        statementIds: ['s3'],
        category: 'NON_FUNCTIONAL_REQUIREMENT',
        nfrDimension: 'PERFORMANCE',
        title: 'Send within 24 hours',
        description: 'Quotes must be sent within 24 hours.',
        // Deliberately fabricated: these words are not in the block. The
        // application has to notice, and the evidence score has to say so.
        evidence: [{ blockId: blockIds.brief[2], excerpt: 'quotes are dispatched by courier' }],
        confidence: 0.95,
      },
    ],
    nonRequirementBlocks: [],
  });

  /* --------------------------------------------- chunk 2: the addendum */

  respond('requirement.normalize', {
    statements: [
      {
        id: 's4',
        text: 'Quotes must be sent within 24 hours.',
        blockIds: [blockIds.addendum[0]],
      },
      {
        id: 's5',
        text: 'Quotes are sent to the customer immediately, with no approval step.',
        blockIds: [blockIds.addendum[1]],
      },
    ],
  });

  respond('requirement.classify', {
    classifications: [
      { statementId: 's4', category: 'NON_FUNCTIONAL_REQUIREMENT', confidence: 0.8 },
      { statementId: 's5', category: 'BUSINESS_RULE', confidence: 0.85 },
    ],
  });

  respond('requirement.extract', {
    items: [
      {
        id: 'r4',
        statementIds: ['s4'],
        category: 'NON_FUNCTIONAL_REQUIREMENT',
        nfrDimension: 'PERFORMANCE',
        title: 'Send within 24 hours',
        description: 'Quotes must be sent within 24 hours.',
        evidence: [{ blockId: blockIds.addendum[0], excerpt: 'sent within 24 hours' }],
        confidence: 0.85,
      },
      {
        id: 'r5',
        statementIds: ['s5'],
        category: 'BUSINESS_RULE',
        title: 'No approval step',
        description: 'Quotes are sent to the customer immediately, with no approval step.',
        evidence: [{ blockId: blockIds.addendum[1], excerpt: 'no approval step' }],
        confidence: 0.9,
      },
    ],
    // A page number. Read, judged, and accounted for with a reason — which is
    // what makes coverage a real figure rather than a ratio of what was found.
    nonRequirementBlocks: [
      { blockId: blockIds.addendum[2], reason: 'A page number, not a requirement.' },
    ],
  });

  /* ------------------------------------------------- across the chunks */

  // Restated duplicates only: the identical "within 24 hours" pair is found by
  // the application's own comparison, and does not need the model.
  respond('requirement.duplicates', { groups: [] });

  respond('requirement.conflicts', {
    conflicts: [
      {
        id: 'c1',
        kind: 'CONTRADICTION',
        severity: 'CRITICAL',
        summary:
          'One document requires manager approval before a quote is sent; the other says quotes are sent immediately with no approval.',
        positions: [
          { itemId: 'REQ-002', statement: 'A manager must approve every quote before it is sent.' },
          { itemId: 'REQ-005', statement: 'Quotes are sent immediately, with no approval step.' },
        ],
      },
    ],
  });

  respond('requirement.ambiguity', {
    findings: [
      {
        id: 'a1',
        itemId: 'REQ-003',
        kind: 'UNQUANTIFIED',
        phrase: 'within 24 hours',
        whyNotImplementable: 'From when — the quote being built, or the manager approving it?',
        suggestion: 'Within 24 hours of the manager approving the quote.',
      },
    ],
  });

  respond('requirement.missing', {
    findings: [
      {
        id: 'm1',
        itemId: 'REQ-001',
        dimension: 'ACCEPTANCE_CRITERIA',
        whyItMatters: 'Nothing states what a completed quote must contain.',
        blocking: false,
      },
    ],
  });

  // Two documents, so terminology is checked across them.
  respond('baseline.crossSource', { findings: [] });

  respond('clarification.generate', {
    questions: [
      {
        id: 'q1',
        question: 'Does a manager have to approve a quote before it is sent to the customer?',
        reason: 'Your two documents say different things, and both cannot be built.',
        category: 'CONFLICT',
        impact: 'BLOCKING',
        itemIds: ['REQ-002', 'REQ-005'],
      },
    ],
  });

  script.applyTo(provider);
}

/**
 * Collects each task's responses, then registers them as ordered scripts.
 *
 * Written in pipeline order above so the fixture reads like a transcript of the
 * run rather than as a lookup table somebody has to simulate in their head.
 */
class Script {
  private readonly byTask = new Map<AiTaskId, string[]>();

  add(taskId: AiTaskId, payload: unknown): void {
    this.byTask.set(taskId, [...(this.byTask.get(taskId) ?? []), JSON.stringify(payload)]);
  }

  applyTo(provider: DeterministicProvider): void {
    for (const [taskId, responses] of this.byTask) {
      provider.registerSequence(taskId, responses);
    }
  }
}
