import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { ExtractedBlock } from '@wdrg/contracts';

import { RequirementSourceRepository } from '../../requirements/requirement-source.repository';
import type { EvidenceContext, SourceContext } from './evidence.service';
import type { ChunkSource } from './chunker';

/**
 * The bridge from Phase 3's reviewed content into Phase 4's analysis.
 *
 * One rule governs it, and it is the reason this is a separate service rather
 * than a query inside the orchestrator: **only reviewed effective content is
 * analysed.**
 *
 * *Effective* means the current revision — a user's corrections, not the raw
 * extraction they corrected. Analysing the original would silently discard the
 * fix somebody made to an OCR error, and the requirement drawn from it would
 * cite text the user had already told us was wrong.
 *
 * *Reviewed* means a person confirmed it. A source still sitting in
 * `REVIEW_REQUIRED` has known problems, and building a requirement baseline on
 * top of content nobody has checked produces a document whose foundation is
 * unexamined.
 */
@Injectable()
export class EvidenceLoader {
  constructor(private readonly sources: RequirementSourceRepository) {}

  /**
   * Every source whose content is ready to analyse, with its blocks.
   *
   * Returned in a stable order — by creation, as the user added them — so chunk
   * indices and requirement keys come out the same for the same project. A
   * baseline whose numbering shuffled between runs would be unusable for
   * comparing versions.
   */
  async loadReviewed(projectId: string): Promise<LoadedSource[]> {
    const documents = await this.sources.listForProject(projectId);
    const loaded: LoadedSource[] = [];

    for (const document of documents) {
      if (document.status !== 'READY' || document.reviewStatus !== 'REVIEWED') {
        continue;
      }

      const revision = await this.sources.findRevision(document.sourceId, document.currentRevision);

      if (!revision) {
        continue;
      }

      const blocks = (revision.blocks as ExtractedBlock[]).filter(
        (block) => block.text.trim().length > 0,
      );

      if (blocks.length === 0) {
        continue;
      }

      loaded.push({
        sourceId: document.sourceId,
        sourceName: document.title,
        revision: document.currentRevision,
        reviewed: true,
        blocks,
      });
    }

    return loaded;
  }

  /**
   * A digest of exactly what would be analysed.
   *
   * The whole mechanism behind outdated-state propagation. It covers each
   * source's id, its current revision and its block text, so *any* change that
   * would alter the analysis changes the digest: a document added, removed,
   * re-extracted, corrected, or un-reviewed.
   *
   * Comparing two digests answers "have the sources moved on since this
   * baseline was approved?" in one string comparison, with no re-reading and no
   * heuristic about what counts as a meaningful change.
   */
  digest(sources: readonly LoadedSource[]): string {
    const hash = createHash('sha256');

    for (const source of [...sources].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
      hash.update(source.sourceId);
      hash.update(String(source.revision));

      for (const block of source.blocks) {
        hash.update(block.id);
        hash.update(block.text);
      }
    }

    return hash.digest('hex');
  }

  /** The same sources, in the shape the chunker wants. */
  toChunkSources(sources: readonly LoadedSource[]): ChunkSource[] {
    return sources.map((source) => ({
      sourceId: source.sourceId,
      sourceName: source.sourceName,
      blocks: source.blocks,
    }));
  }

  /**
   * The lookup the evidence service verifies citations against.
   *
   * Built from *every* source in the project, not only the reviewed ones, so a
   * requirement citing an unreviewed document is scored as unreviewed rather
   * than reported as a hallucination. The two are different problems and they
   * deserve different messages.
   */
  async buildContext(projectId: string): Promise<EvidenceContext> {
    const documents = await this.sources.listForProject(projectId);
    const sources = new Map<string, SourceContext>();

    for (const document of documents) {
      const revision = await this.sources.findRevision(document.sourceId, document.currentRevision);

      const blocks = new Map<string, ExtractedBlock>();

      for (const block of (revision?.blocks ?? []) as ExtractedBlock[]) {
        blocks.set(block.id, block);
      }

      sources.set(document.sourceId, {
        sourceId: document.sourceId,
        sourceName: document.title,
        reviewed: document.reviewStatus === 'REVIEWED',
        blocks,
      });
    }

    return { sources };
  }
}

export interface LoadedSource {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly revision: number;
  readonly reviewed: boolean;
  readonly blocks: readonly ExtractedBlock[];
}
