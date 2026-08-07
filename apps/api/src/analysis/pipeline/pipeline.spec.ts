import {
  calculateAlignment,
  calculateBlockers,
  calculateCoverage,
  calculateEvidenceConfidence,
  INCOMPLETE_ALIGNMENT_CAP,
  type BlockDispositionRecord,
  type Clarification,
  type Conflict,
  type DuplicateGroup,
  type EvidenceFacts,
  type ExtractedBlock,
  type RequirementItem,
} from '@wdrg/contracts';

import { baseBlockId, chunkEvidence, planChunks } from './chunker';
import { EvidenceService } from './evidence.service';
import { reconcile, type CandidateItem } from './reconciler';
import { checkExcerpt, normalizeForComparison, similarity, tokenize } from './text-similarity';

/**
 * The parts of Phase 4 that decide things without asking a model.
 *
 * Deliberately the largest suite in the phase, because these are the parts that
 * *govern*. The model drafts; chunking decides what it is allowed to see,
 * reconciliation decides what survives, and the calculations decide whether a
 * baseline may be approved. Every one of them is deterministic, so every one of
 * them can be pinned down here rather than hoped for at runtime.
 */

const NOW = '2026-08-07T10:00:00.000Z';

function block(id: string, text: string, overrides: Partial<ExtractedBlock> = {}): ExtractedBlock {
  return {
    id,
    kind: 'paragraph',
    text,
    reference: { pageNumber: 1 },
    confidence: 1,
    viaOcr: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------ chunking */

describe('chunking', () => {
  it('never puts two documents in one chunk', () => {
    // The rule traceability depends on. Two sources in one chunk makes "which
    // file did this come from" a question about the model's attention.
    const plan = planChunks(
      [
        { sourceId: 's1', sourceName: 'Brief.pdf', blocks: [block('a', 'One.')] },
        { sourceId: 's2', sourceName: 'Notes.docx', blocks: [block('b', 'Two.')] },
      ],
      { budgetCharacters: 12_000, maxChunks: 200 },
    );

    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks[0]?.sourceId).toBe('s1');
    expect(plan.chunks[1]?.sourceId).toBe('s2');
  });

  it('places every block in exactly one chunk', () => {
    const blocks = Array.from({ length: 40 }, (_, index) =>
      block(`b${index}`, `Requirement number ${index}. `.repeat(30)),
    );

    const plan = planChunks([{ sourceId: 's1', sourceName: 'Big.pdf', blocks }], {
      budgetCharacters: 2_000,
      maxChunks: 200,
    });

    const placed = plan.chunks.flatMap((chunk) => chunk.blockIds);

    // Neither dropped nor duplicated: coverage is counted in blocks, so a block
    // appearing twice inflates it and one appearing in none is a silent hole.
    expect(new Set(placed).size).toBe(blocks.length);
    expect(placed).toHaveLength(blocks.length);
  });

  it('breaks at a heading rather than mid-section when it can', () => {
    const plan = planChunks(
      [
        {
          sourceId: 's1',
          sourceName: 'Spec.docx',
          blocks: [
            block('h1', 'Ordering', { kind: 'heading' }),
            block('p1', 'The system must accept an order.'),
            block('h2', 'Invoicing', { kind: 'heading' }),
            block('p2', 'The system must issue an invoice.'),
          ],
        },
      ],
      { budgetCharacters: 12_000, maxChunks: 200 },
    );

    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks[0]?.blockIds).toEqual(['h1', 'p1']);
    expect(plan.chunks[1]?.blockIds).toEqual(['h2', 'p2']);
    expect(plan.chunks[0]?.boundary).toBe('heading');
  });

  it('splits an oversized block instead of truncating it', () => {
    /*
     * The rule that matters most. Dropping the tail of a block would report
     * complete coverage over incomplete reading — a requirement lost, with
     * nothing recording that it was.
     */
    const long = Array.from({ length: 200 }, (_, index) => `Sentence number ${index}.`).join(' ');
    const plan = planChunks(
      [{ sourceId: 's1', sourceName: 'Wall.txt', blocks: [block('b0', long)] }],
      { budgetCharacters: 2_000, maxChunks: 200 },
    );

    const carried = plan.chunks
      .flatMap((chunk) => chunk.contents)
      .map((piece) => piece.text)
      .join(' ');

    // Every sentence survives somewhere.
    for (const index of [0, 99, 199]) {
      expect(carried).toContain(`Sentence number ${index}.`);
    }

    expect(plan.chunks.some((chunk) => chunk.blockParts.length > 0)).toBe(true);
  });

  it('cites a split block by part, and the part maps back to the block', () => {
    const long = 'A requirement sentence. '.repeat(400);
    const plan = planChunks(
      [{ sourceId: 's1', sourceName: 'Wall.txt', blocks: [block('b0', long)] }],
      { budgetCharacters: 2_000, maxChunks: 200 },
    );

    const evidence = chunkEvidence(plan.chunks[0]!);

    expect(evidence[0]?.blockId).toBe('b0#0');
    expect(baseBlockId('b0#0')).toBe('b0');
    expect(baseBlockId('b0')).toBe('b0');
  });

  it('refuses the excess rather than silently analysing part of a project', () => {
    const blocks = Array.from({ length: 60 }, (_, index) =>
      block(`b${index}`, `Requirement ${index}. `.repeat(200)),
    );

    const plan = planChunks([{ sourceId: 's1', sourceName: 'Huge.pdf', blocks }], {
      budgetCharacters: 2_000,
      maxChunks: 5,
    });

    expect(plan.chunks).toHaveLength(5);
    // Reported, so they become `not_analysed` and block approval — rather than
    // vanishing behind a confident baseline built from the first five chunks.
    expect(plan.unplacedBlockIds.length).toBeGreaterThan(0);
  });

  it('skips blocks with nothing in them', () => {
    const plan = planChunks(
      [
        {
          sourceId: 's1',
          sourceName: 'Sparse.txt',
          blocks: [block('a', '   '), block('b', 'Real content.')],
        },
      ],
      { budgetCharacters: 12_000, maxChunks: 200 },
    );

    expect(plan.chunks[0]?.blockIds).toEqual(['b']);
  });
});

/* ---------------------------------------------------------- similarity */

describe('text comparison', () => {
  it('ignores punctuation, case and typographic quotes', () => {
    // A requirement restated with a different comma is the same requirement,
    // and a PDF and the DOCX it came from differ in exactly this way.
    expect(normalizeForComparison('The “System” must — send a quote!')).toBe(
      'the system must send a quote',
    );
  });

  it('keeps the words that change what a requirement means', () => {
    /*
     * The stop-word list is short on purpose. Dropping "must" and "not" would
     * make "must not delete records" look like "must delete records", which is
     * the most dangerous false duplicate imaginable.
     */
    const tokens = tokenize('The system must not delete all records');

    expect(tokens).toContain('must');
    expect(tokens).toContain('not');
    expect(tokens).toContain('all');
    expect(tokens).not.toContain('the');
  });

  it('scores identical statements as identical and different ones as different', () => {
    expect(similarity('The system must send a quote.', 'The system must send a quote')).toBe(1);
    expect(
      similarity('The system must send a quote.', 'Users log in with a password.'),
    ).toBeLessThan(0.2);
  });

  it.each([
    ['verbatim', 'must send a quote', 'The system must send a quote within 24 hours.'],
    ['partial', 'system must send quote hours', 'The system must send a quote within 24 hours.'],
  ])('recognises a %s quotation', (expected, excerpt, source) => {
    expect(checkExcerpt(excerpt, source)).toBe(expected);
  });

  it('recognises a fabricated quotation as absent', () => {
    // The check that turns `verified: true` into a fact rather than a claim.
    expect(
      checkExcerpt(
        'The system must integrate with Salesforce nightly',
        'The system must send a quote within 24 hours.',
      ),
    ).toBe('absent');
  });
});

/* -------------------------------------------------------- reconciliation */

describe('cross-chunk reconciliation', () => {
  function candidate(overrides: Partial<CandidateItem> = {}): CandidateItem {
    return {
      localId: 'r1',
      chunkId: 'c0',
      sourceId: 's1',
      sourceName: 'Brief.pdf',
      title: 'Send a quote',
      statement: 'The system must send a quote within 24 hours.',
      category: 'functional',
      priority: 'unspecified',
      modelConfidence: 0.8,
      evidence: [{ blockId: 'b0', excerpt: 'must send a quote' }],
      ...overrides,
    };
  }

  it('numbers requirements in reading order', () => {
    const result = reconcile({
      candidates: [candidate(), candidate({ localId: 'r2', title: 'Second' })],
      nonRequirementBlocks: [],
      analysedBlocks: [{ sourceId: 's1', blockId: 'b0', chunkId: 'c0' }],
      unanalysedBlocks: [],
    });

    expect(result.items.map((item) => item.key)).toEqual(['REQ-001', 'REQ-002']);
  });

  it('finds the same requirement stated in two different documents', () => {
    /*
     * The case chunking would otherwise hide. Neither chunk can see the other,
     * so this pairing exists only after reconciliation — and it is worth a
     * person's attention because two authors wrote it independently.
     */
    const result = reconcile({
      candidates: [
        candidate({ chunkId: 'c0', sourceId: 's1', sourceName: 'Brief.pdf' }),
        candidate({ localId: 'r2', chunkId: 'c1', sourceId: 's2', sourceName: 'Notes.docx' }),
      ],
      nonRequirementBlocks: [],
      analysedBlocks: [],
      unanalysedBlocks: [],
    });

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.kind).toBe('exact');
    expect(result.duplicates[0]?.crossSource).toBe(true);
    expect(result.duplicates[0]?.crossChunk).toBe(true);
    expect(result.duplicates[0]?.rationale).toMatch(/Brief\.pdf, Notes\.docx/);
  });

  it('finds near duplicates that are not textually identical', () => {
    const result = reconcile({
      candidates: [
        candidate({ statement: 'The system must send a quote within 24 hours.' }),
        candidate({
          localId: 'r2',
          chunkId: 'c1',
          statement: 'The system must send a quote within 24 hours to the customer.',
        }),
      ],
      nonRequirementBlocks: [],
      analysedBlocks: [],
      unanalysedBlocks: [],
    });

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]?.kind).toBe('near');
  });

  it('does not group requirements that merely share vocabulary', () => {
    const result = reconcile({
      candidates: [
        candidate({ statement: 'The system must send a quote to the customer.' }),
        candidate({
          localId: 'r2',
          statement: 'The system must archive a quote after the customer rejects it.',
        }),
      ],
      nonRequirementBlocks: [],
      analysedBlocks: [],
      unanalysedBlocks: [],
    });

    expect(result.duplicates).toHaveLength(0);
  });

  it('never groups a requirement into two groups', () => {
    const result = reconcile({
      candidates: [
        candidate({ localId: 'r1' }),
        candidate({ localId: 'r2' }),
        candidate({ localId: 'r3' }),
      ],
      nonRequirementBlocks: [],
      analysedBlocks: [],
      unanalysedBlocks: [],
    });

    const keys = result.duplicates.flatMap((group) => group.keys);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every block a disposition, with no gaps', () => {
    /*
     * The completeness that makes coverage real. Without it, a block the
     * pipeline never reached looks identical to one it read and found nothing
     * in — and those two are the difference between a complete baseline and one
     * with a hole in it.
     */
    const result = reconcile({
      candidates: [candidate({ evidence: [{ blockId: 'b0', excerpt: 'quote' }] })],
      nonRequirementBlocks: [
        { chunkId: 'c0', sourceId: 's1', blockId: 'b1', reason: 'A page header.' },
      ],
      analysedBlocks: [
        { sourceId: 's1', blockId: 'b0', chunkId: 'c0' },
        { sourceId: 's1', blockId: 'b1', chunkId: 'c0' },
      ],
      unanalysedBlocks: [{ sourceId: 's1', blockId: 'b2' }],
    });

    const byBlock = new Map(result.dispositions.map((record) => [record.blockId, record]));

    expect(byBlock.get('b0')?.disposition).toBe('covered');
    expect(byBlock.get('b1')?.disposition).toBe('no_requirement');
    expect(byBlock.get('b1')?.reason).toBe('A page header.');
    expect(byBlock.get('b2')?.disposition).toBe('not_analysed');
    expect(result.dispositions).toHaveLength(3);
  });

  it('keeps two documents’ blocks apart when they share block ids', () => {
    /*
     * Block ids are unique within a source, not across a project: two
     * pasted-text documents both start at `b0`. Keying dispositions on the
     * block alone collapses one document's into the other's, and coverage then
     * reports a hole where there is none — or, far worse, none where there is.
     *
     * This was a real bug, caught by the integration suite rather than here.
     */
    const result = reconcile({
      candidates: [
        candidate({ sourceId: 's1', evidence: [{ blockId: 'b0', excerpt: 'quote' }] }),
        candidate({
          localId: 'r2',
          sourceId: 's2',
          sourceName: 'Other.docx',
          statement: 'Something entirely different about invoices.',
          evidence: [{ blockId: 'b0', excerpt: 'invoices' }],
        }),
      ],
      nonRequirementBlocks: [],
      analysedBlocks: [
        { sourceId: 's1', blockId: 'b0', chunkId: 'c0' },
        { sourceId: 's2', blockId: 'b0', chunkId: 'c1' },
      ],
      unanalysedBlocks: [],
    });

    expect(result.dispositions).toHaveLength(2);
    expect(result.dispositions.map((record) => record.sourceId).sort()).toEqual(['s1', 's2']);
    expect(result.dispositions.every((record) => record.disposition === 'covered')).toBe(true);
  });

  it('records an honest reason when the model accounted for nothing', () => {
    const result = reconcile({
      candidates: [],
      nonRequirementBlocks: [],
      analysedBlocks: [{ sourceId: 's1', blockId: 'b9', chunkId: 'c0' }],
      unanalysedBlocks: [],
    });

    // Not left blank, which would present an omission as a judgement.
    expect(result.dispositions[0]?.reason).toMatch(/gave no reason/i);
  });
});

/* ---------------------------------------------------- evidence confidence */

describe('evidence-derived confidence', () => {
  function facts(overrides: Partial<EvidenceFacts> = {}): EvidenceFacts {
    return {
      referenceCount: 1,
      verifiedReferenceCount: 1,
      partialReferenceCount: 0,
      locatedReferenceCount: 1,
      distinctSourceCount: 1,
      allSourcesReviewed: true,
      usedOcr: false,
      lowExtractionConfidence: false,
      hasConfirmedClarification: false,
      humanReviewed: false,
      inOpenConflict: false,
      hasOpenAmbiguity: false,
      hasUnknownSource: false,
      ...overrides,
    };
  }

  it('scores a well-evidenced requirement high', () => {
    const score = calculateEvidenceConfidence(facts(), NOW);

    expect(score.band).toBe('high');
    expect(score.score).toBeGreaterThanOrEqual(0.75);
  });

  it('scores a requirement with no source as unsupported, not merely low', () => {
    // Nothing to check it against, so a number would dignify a guess.
    const score = calculateEvidenceConfidence(facts({ referenceCount: 0 }), NOW);

    expect(score.score).toBe(0);
    expect(score.band).toBe('unsupported');
  });

  it('scores a citation to a document that does not exist as unsupported', () => {
    const score = calculateEvidenceConfidence(facts({ hasUnknownSource: true }), NOW);

    expect(score.band).toBe('unsupported');
    expect(score.contributions[0]?.explanation).toMatch(/not part of this project/i);
  });

  it('penalises a quotation that is not in the document it cites', () => {
    const unverified = calculateEvidenceConfidence(
      facts({ verifiedReferenceCount: 0, partialReferenceCount: 0 }),
      NOW,
    );
    const verified = calculateEvidenceConfidence(facts(), NOW);

    expect(unverified.score).toBeLessThan(verified.score);
    expect(unverified.contributions.map((c) => c.signal)).toContain('unverified_excerpt');
  });

  it('is explainable: the score is the sum of what it lists', () => {
    /*
     * Not a nicety. This score decides review order and blocks approval, and a
     * reviewer who cannot see why it is what it is has to either trust it
     * blindly or ignore it.
     */
    const score = calculateEvidenceConfidence(facts({ distinctSourceCount: 2 }), NOW);
    const total = score.contributions.reduce((sum, entry) => sum + entry.weight, 0);

    expect(score.score).toBeCloseTo(Math.min(1, total), 3);
    expect(score.contributions.every((entry) => entry.explanation.length > 0)).toBe(true);
  });

  it('is deterministic', () => {
    const a = calculateEvidenceConfidence(facts(), NOW);
    const b = calculateEvidenceConfidence(facts(), NOW);

    expect(a).toEqual(b);
  });

  it('lowers the score while a conflict is open, and raises it when resolved', () => {
    const conflicted = calculateEvidenceConfidence(facts({ inOpenConflict: true }), NOW);
    const settled = calculateEvidenceConfidence(facts(), NOW);

    expect(conflicted.score).toBeLessThan(settled.score);
  });

  it('records the rule version, so an old score stays interpretable', () => {
    expect(calculateEvidenceConfidence(facts(), NOW).ruleVersion).toBe('v1');
  });

  it('never lets the model influence it', () => {
    // There is no field for the model's opinion in the facts at all. This test
    // exists so that adding one has to be a deliberate act with a failing test.
    const keys = Object.keys(facts());

    expect(keys.some((key) => key.toLowerCase().includes('model'))).toBe(false);
  });
});

/* ------------------------------------------------------ excerpt resolution */

describe('EvidenceService', () => {
  const service = new EvidenceService();
  const context = {
    sources: new Map([
      [
        's1',
        {
          sourceId: 's1',
          sourceName: 'Brief.pdf',
          reviewed: true,
          blocks: new Map([['b0', block('b0', 'The system must send a quote within 24 hours.')]]),
        },
      ],
    ]),
  };

  it('verifies a real quotation and copies the stored location', () => {
    const [link] = service.resolveReferences(
      [{ blockId: 'b0', excerpt: 'must send a quote' }],
      's1',
      context,
    );

    expect(link?.verified).toBe(true);
    // From the stored block, never from the model. A page number a model
    // produced is a plausible number, which is worse than none.
    expect(link?.reference).toEqual({ pageNumber: 1 });
  });

  it('keeps a citation to a block that does not exist, marked unverified', () => {
    // Dropping it would hide the hallucination; keeping it lets the blocker
    // calculation see it and tell the reviewer plainly.
    const [link] = service.resolveReferences(
      [{ blockId: 'b99', excerpt: 'anything' }],
      's1',
      context,
    );

    expect(link?.verified).toBe(false);
    expect(link?.blockId).toBe('b99');
  });

  it('marks a fabricated quotation of a real block unverified', () => {
    const [link] = service.resolveReferences(
      [{ blockId: 'b0', excerpt: 'must integrate with Salesforce every night' }],
      's1',
      context,
    );

    expect(link?.verified).toBe(false);
  });

  it('resolves a split block’s part citation back to the block', () => {
    const [link] = service.resolveReferences(
      [{ blockId: 'b0#2', excerpt: 'must send a quote' }],
      's1',
      context,
    );

    expect(link?.blockId).toBe('b0');
    expect(link?.verified).toBe(true);
  });
});

/* -------------------------------------------------------------- coverage */

describe('coverage', () => {
  function disposition(
    blockId: string,
    kind: BlockDispositionRecord['disposition'],
  ): BlockDispositionRecord {
    return { sourceId: 's1', blockId, disposition: kind, itemIds: [] };
  }

  it('counts an accounted-for block whether or not it produced a requirement', () => {
    // "No requirement here" is a decision with a reason, not an absence.
    const coverage = calculateCoverage(
      [
        disposition('b0', 'covered'),
        disposition('b1', 'no_requirement'),
        disposition('b2', 'duplicate_content'),
      ],
      [{ sourceId: 's1', sourceName: 'Brief.pdf', blockCount: 3 }],
    );

    expect(coverage.ratio).toBe(1);
  });

  it('counts an unanalysed block as a gap', () => {
    const coverage = calculateCoverage(
      [disposition('b0', 'covered'), disposition('b1', 'not_analysed')],
      [{ sourceId: 's1', sourceName: 'Brief.pdf', blockCount: 2 }],
    );

    expect(coverage.notAnalysedBlocks).toBe(1);
    expect(coverage.ratio).toBe(0.5);
  });

  it('counts a block with no record at all as unanalysed', () => {
    /*
     * The case this number exists to catch: something the pipeline never
     * reached and never reported. Ignoring an absent record would let a
     * missing block quietly improve the score.
     */
    const coverage = calculateCoverage(
      [disposition('b0', 'covered')],
      [{ sourceId: 's1', sourceName: 'Brief.pdf', blockCount: 10 }],
    );

    expect(coverage.notAnalysedBlocks).toBe(9);
    expect(coverage.ratio).toBe(0.1);
  });

  it('reports coverage per document, so a skipped file is visible', () => {
    const coverage = calculateCoverage(
      [disposition('b0', 'covered')],
      [
        { sourceId: 's1', sourceName: 'Brief.pdf', blockCount: 1 },
        { sourceId: 's2', sourceName: 'Ignored.docx', blockCount: 5 },
      ],
    );

    expect(coverage.bySource.find((entry) => entry.sourceId === 's2')?.ratio).toBe(0);
  });
});

/* ------------------------------------------------------------- alignment */

describe('alignment and blockers', () => {
  function item(overrides: Partial<RequirementItem> = {}): RequirementItem {
    return {
      id: 'req_1',
      projectId: 'p1',
      runId: 'run_1',
      key: 'REQ-001',
      title: 'Send a quote',
      statement: 'The system must send a quote within 24 hours.',
      category: 'functional',
      priority: 'unspecified',
      references: [
        {
          sourceId: 's1',
          blockId: 'b0',
          excerpt: 'must send a quote',
          reference: { pageNumber: 1 },
          verified: true,
        },
      ],
      evidenceConfidence: {
        score: 0.9,
        band: 'high',
        contributions: [],
        ruleVersion: 'v1',
        calculatedAt: NOW,
      },
      origin: 'ai',
      status: 'draft',
      editedByUser: false,
      chunkIds: ['c0'],
      createdAt: NOW,
      updatedAt: NOW,
      version: 0,
      ...overrides,
    };
  }

  const cleanCoverage = calculateCoverage(
    [{ sourceId: 's1', blockId: 'b0', disposition: 'covered', itemIds: ['req_1'] }],
    [{ sourceId: 's1', sourceName: 'Brief.pdf', blockCount: 1 }],
  );

  const empty = {
    conflicts: [] as Conflict[],
    duplicates: [] as DuplicateGroup[],
    ambiguities: [],
    missing: [],
    clarifications: [] as Clarification[],
  };

  function conflict(overrides: Partial<Conflict> = {}): Conflict {
    return {
      id: 'con_1',
      projectId: 'p1',
      runId: 'run_1',
      kind: 'contradiction',
      severity: 'blocking',
      itemIds: ['req_1', 'req_2'],
      summary: 'Two documents disagree.',
      positions: [
        { itemId: 'req_1', statement: 'A', sourceId: 's1' },
        { itemId: 'req_2', statement: 'B', sourceId: 's2' },
      ],
      crossChunk: true,
      crossSource: true,
      status: 'open',
      createdAt: NOW,
      version: 0,
      ...overrides,
    };
  }

  it('reaches complete only when nothing is outstanding', () => {
    const alignment = calculateAlignment({ items: [item()], coverage: cleanCoverage, ...empty });

    expect(alignment.isComplete).toBe(true);
    expect(alignment.incompleteReasons).toEqual([]);
    expect(alignment.overall).toBeGreaterThan(INCOMPLETE_ALIGNMENT_CAP);
  });

  it('never claims completeness merely because generation succeeded', () => {
    /*
     * The rule this whole calculation exists for. Two hundred requirements
     * extracted successfully, six conflicts open — a number near 100 beside
     * those six is not an optimistic estimate, it is a false statement in a
     * document a client is being asked to sign.
     */
    const alignment = calculateAlignment({
      items: [item()],
      coverage: cleanCoverage,
      ...empty,
      conflicts: [conflict()],
    });

    expect(alignment.isComplete).toBe(false);
    expect(alignment.overall).toBeLessThanOrEqual(INCOMPLETE_ALIGNMENT_CAP);
    expect(alignment.incompleteReasons.join(' ')).toMatch(/blocking conflict/i);
  });

  it.each([
    [
      'unanalysed content',
      {
        coverage: calculateCoverage(
          [{ sourceId: 's1', blockId: 'b1', disposition: 'not_analysed', itemIds: [] }],
          [{ sourceId: 's1', sourceName: 'Brief.pdf', blockCount: 1 }],
        ),
      },
      /never analysed/i,
    ],
    ['an untraceable requirement', { items: [item({ references: [] })] }, /cannot be traced/i],
  ])('reports %s as a reason it is not complete', (_label, overrides, expected) => {
    const alignment = calculateAlignment({
      items: [item()],
      coverage: cleanCoverage,
      ...empty,
      ...overrides,
    });

    expect(alignment.isComplete).toBe(false);
    expect(alignment.incompleteReasons.join(' ')).toMatch(expected);
  });

  it('produces no blockers for a clean baseline', () => {
    const blockers = calculateBlockers({
      items: [item()],
      coverage: cleanCoverage,
      ...empty,
      knownSourceIds: ['s1'],
    });

    expect(blockers).toEqual([]);
  });

  it.each([
    ['untraceable_requirement', { items: [item({ references: [] })] }],
    [
      'unsupported_requirement',
      {
        items: [
          item({
            evidenceConfidence: {
              score: 0.1,
              band: 'unsupported' as const,
              contributions: [],
              ruleVersion: 'v1',
              calculatedAt: NOW,
            },
          }),
        ],
      },
    ],
    ['blocking_conflict', { conflicts: [conflict()] }],
  ])('blocks approval on %s', (kind, overrides) => {
    const blockers = calculateBlockers({
      items: [item()],
      coverage: cleanCoverage,
      ...empty,
      ...overrides,
      knownSourceIds: ['s1'],
    });

    expect(blockers.map((blocker) => blocker.kind)).toContain(kind);
  });

  it('blocks approval on a citation to a document this project does not have', () => {
    const blockers = calculateBlockers({
      items: [item()],
      coverage: cleanCoverage,
      ...empty,
      // The item cites s1, which is not in the project's source list.
      knownSourceIds: ['s2'],
    });

    expect(blockers.map((blocker) => blocker.kind)).toContain('hallucinated_reference');
  });

  it('blocks an empty baseline, and says so on its own', () => {
    const blockers = calculateBlockers({
      items: [],
      coverage: cleanCoverage,
      ...empty,
      knownSourceIds: ['s1'],
    });

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.kind).toBe('empty_baseline');
  });

  it('gives every blocker something the reviewer can act on', () => {
    // A gate that says "not allowed" without saying why is a gate people learn
    // to route around.
    const blockers = calculateBlockers({
      items: [item({ references: [] })],
      coverage: calculateCoverage(
        [{ sourceId: 's1', blockId: 'b1', disposition: 'not_analysed', itemIds: [] }],
        [{ sourceId: 's1', sourceName: 'Brief.pdf', blockCount: 1 }],
      ),
      ...empty,
      conflicts: [conflict()],
      knownSourceIds: ['s1'],
    });

    expect(blockers.length).toBeGreaterThan(1);
    expect(blockers.every((blocker) => blocker.action.length > 0)).toBe(true);
    expect(blockers.every((blocker) => blocker.summary.length > 0)).toBe(true);
  });

  it('stops blocking once a conflict is accepted as a known risk', () => {
    const blockers = calculateBlockers({
      items: [item()],
      coverage: cleanCoverage,
      ...empty,
      conflicts: [conflict({ status: 'accepted_risk' })],
      knownSourceIds: ['s1'],
    });

    expect(blockers.map((blocker) => blocker.kind)).not.toContain('blocking_conflict');
  });

  it('ignores rejected requirements when judging the baseline', () => {
    const blockers = calculateBlockers({
      items: [item(), item({ id: 'req_2', references: [], status: 'rejected' })],
      coverage: cleanCoverage,
      ...empty,
      knownSourceIds: ['s1'],
    });

    expect(blockers).toEqual([]);
  });
});
