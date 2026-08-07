import { Injectable } from '@nestjs/common';
import {
  calculateEvidenceConfidence,
  hasLocation,
  isLowConfidence,
  type EvidenceConfidence,
  type EvidenceFacts,
  type ExtractedBlock,
  type RequirementItem,
  type TraceabilityLink,
} from '@wdrg/contracts';

import { baseBlockId } from './chunker';
import { checkExcerpt } from './text-similarity';

/**
 * Turning a model's citations into evidence the application has checked.
 *
 * The model says "this requirement came from block b7, and b7 says X". Both
 * halves are claims. This service verifies them against the stored extraction:
 * does b7 exist in a source belonging to this project, and does it actually say
 * X? Only then does a citation become a `TraceabilityLink` with `verified: true`.
 *
 * That verification is what makes the evidence-derived confidence meaningful.
 * Without it the score would be computed from the model's own assertions, which
 * is the thing it exists not to be.
 */

export interface SourceContext {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly reviewed: boolean;
  readonly blocks: ReadonlyMap<string, ExtractedBlock>;
}

export interface EvidenceContext {
  /** Every source in the project, by id. */
  readonly sources: ReadonlyMap<string, SourceContext>;
}

export interface ItemEvidenceSignals {
  /** Keys of confirmed clarifications this requirement is traced to. */
  readonly clarificationKeys: readonly string[];
  readonly humanReviewed: boolean;
  readonly inOpenConflict: boolean;
  readonly hasOpenAmbiguity: boolean;
}

/** A confirmed clarification answer, as a citable piece of evidence. */
export function clarificationLink(input: {
  clarificationId: string;
  clarificationKey: string;
  answerVersion: number;
  text: string;
}): TraceabilityLink {
  return {
    kind: 'clarification',
    sourceId: input.clarificationId,
    blockId: `answer-v${input.answerVersion}`,
    excerpt: input.text.slice(0, 1_000),
    reference: {},
    /*
     * True, and not as a shortcut. A document excerpt is verified by comparing
     * it against stored block text, because the model claimed it. This text is
     * the answer this application recorded — there is no third party's claim to
     * check, so treating it as unverified would understate what is known.
     */
    verified: true,
    label: input.clarificationKey,
  };
}

@Injectable()
export class EvidenceService {
  /**
   * Resolves a model's citations into verified traceability links.
   *
   * A citation naming a block that does not exist is *kept*, marked unverified,
   * and carries the source id the model invented. Dropping it would hide the
   * hallucination; keeping it means the blocker calculation can see it and the
   * reviewer is told plainly that the model cited something that is not there.
   */
  resolveReferences(
    citations: readonly { blockId: string; excerpt: string }[],
    expectedSourceId: string,
    context: EvidenceContext,
  ): TraceabilityLink[] {
    return citations.map((citation) => {
      const blockId = baseBlockId(citation.blockId);

      const located = this.findBlock(blockId, expectedSourceId, context);

      if (!located) {
        return {
          kind: 'document' as const,
          sourceId: expectedSourceId,
          blockId,
          excerpt: citation.excerpt.slice(0, 1_000),
          reference: {},
          verified: false,
        };
      }

      const support = checkExcerpt(citation.excerpt, located.block.text);

      return {
        kind: 'document' as const,
        sourceId: located.sourceId,
        blockId,
        excerpt: citation.excerpt.slice(0, 1_000),
        // Copied from the stored block, never from the model. A page number the
        // model produced would be a plausible number, which is worse than none.
        reference: located.block.reference,
        verified: support === 'verbatim',
      };
    });
  }

  /**
   * Assembles the facts a confidence score is calculated from.
   *
   * Every field comes from stored data or from a decision a person made.
   * Nothing here is asked of the model.
   */
  buildFacts(
    references: readonly TraceabilityLink[],
    context: EvidenceContext,
    signals: ItemEvidenceSignals,
  ): EvidenceFacts {
    /*
     * Clarification links are held apart from document links throughout.
     * A clarification has no block to look up, so treating one as a document
     * citation would make it look like a hallucinated source — the exact
     * opposite of what it is.
     */
    const documentLinks = references.filter((reference) => reference.kind !== 'clarification');
    const clarificationLinks = references.filter((reference) => reference.kind === 'clarification');

    const resolved = documentLinks.map((reference) => ({
      reference,
      block: this.findBlock(reference.blockId, reference.sourceId, context),
    }));

    const known = resolved.filter((entry) => entry.block !== null);
    const unknown =
      documentLinks.length > 0 && known.length === 0 && clarificationLinks.length === 0;

    const verified = references.filter((reference) => reference.verified).length;
    const partial = known.filter(
      (entry) =>
        !entry.reference.verified &&
        entry.block !== null &&
        checkExcerpt(entry.reference.excerpt ?? '', entry.block.block.text) === 'partial',
    ).length;

    /*
     * Document links only, and guarded.
     *
     * A clarification link has no location to report, and Mongo drops an empty
     * `reference: {}` on write — so a stored link can legitimately arrive with
     * the field missing. A missing location is information ("the extractor could
     * not place this"), not a reason to fail while scoring.
     */
    const located = documentLinks.filter(
      (reference) => reference.reference !== undefined && hasLocation(reference.reference),
    ).length;

    const sourceIds = new Set<string>(
      known.flatMap((entry) => (entry.block ? [entry.block.sourceId] : [])),
    );

    // A confirmed clarification counts as a distinct corroborating source: it is
    // a different person saying the same thing, which is what that signal means.
    for (const link of clarificationLinks) {
      sourceIds.add(link.sourceId);
    }

    return {
      referenceCount: references.length,
      verifiedReferenceCount: verified,
      partialReferenceCount: partial,
      locatedReferenceCount: located,
      distinctSourceCount: sourceIds.size,
      allSourcesReviewed:
        (known.length > 0 || clarificationLinks.length > 0) &&
        known.every((entry) => context.sources.get(entry.block?.sourceId ?? '')?.reviewed === true),
      usedOcr: known.some((entry) => entry.block?.block.viaOcr === true),
      lowExtractionConfidence: known.some(
        (entry) => entry.block !== null && isLowConfidence(entry.block.block),
      ),
      clarificationKeys: signals.clarificationKeys,
      humanReviewed: signals.humanReviewed,
      inOpenConflict: signals.inOpenConflict,
      hasOpenAmbiguity: signals.hasOpenAmbiguity,
      hasUnknownSource: unknown,
    };
  }

  score(
    references: readonly TraceabilityLink[],
    context: EvidenceContext,
    signals: ItemEvidenceSignals,
    now: Date,
  ): EvidenceConfidence {
    return calculateEvidenceConfidence(
      this.buildFacts(references, context, signals),
      now.toISOString(),
    );
  }

  /**
   * Recalculates one item's score against the current state of the project.
   *
   * Called whenever something that feeds the score changes: a conflict is
   * resolved, a clarification is answered, a person accepts an item. A score
   * that was right when it was written and is not recomputed becomes a stale
   * number presented as a current one.
   */
  rescore(
    item: RequirementItem,
    context: EvidenceContext,
    signals: ItemEvidenceSignals,
    now: Date,
  ): EvidenceConfidence {
    return this.score(item.references, context, signals, now);
  }

  private findBlock(
    blockId: string,
    preferredSourceId: string,
    context: EvidenceContext,
  ): { sourceId: string; block: ExtractedBlock } | null {
    const preferred = context.sources.get(preferredSourceId);
    const inPreferred = preferred?.blocks.get(blockId);

    if (preferred && inPreferred) {
      return { sourceId: preferred.sourceId, block: inPreferred };
    }

    /*
     * Block ids are unique within a source, not across a project, so a
     * cross-source search could match the wrong document's `b3`. It runs only
     * when the expected source does not have the block — a model attributing a
     * real quotation to the wrong file — and finding it there is better than
     * reporting a hallucination that did not happen.
     */
    for (const source of context.sources.values()) {
      const block = source.blocks.get(blockId);

      if (block) {
        return { sourceId: source.sourceId, block };
      }
    }

    return null;
  }
}
