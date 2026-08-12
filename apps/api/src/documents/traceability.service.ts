import { Injectable } from '@nestjs/common';
import {
  DOCUMENT_LABELS,
  DOCUMENT_TYPES,
  TRACE_GAP_SEVERITY,
  isConditionalDocument,
  type ArtifactTrace,
  type ClientDependency,
  type DocumentType,
  type RequirementTrace,
  type TraceCoverageEntry,
  type TraceGap,
  type TraceLink,
  type TraceabilityView,
  type WorkPackage,
} from '@wdrg/contracts';

import { AuditService } from '../audit/audit.service';
import { DocumentsRepository } from './documents.repository';
import { UpstreamReader } from './upstream.reader';
import { payloadText } from './documents.mapper';

/**
 * Every approved requirement, followed through every document that mentions it.
 *
 * ## Why this is a read model and not stored
 *
 * The links already exist — a section's references, a feature row's requirement ids, a
 * criterion's, a work package's. Storing a second copy would create a table that can
 * disagree with the documents, and the disagreement would be invisible until somebody
 * trusted it. So this walks the documents on request.
 *
 * The cost is real: seven documents, their rows and their sections, per view. It is
 * paid on an explicitly-opened screen rather than on every document read, and the
 * alternative is a cache that lies.
 *
 * ## What it will not do
 *
 * Invent an edge. If Our Understanding does not cite `REQ-004`, this reports that
 * `REQ-004` does not appear in Our Understanding — it does not go looking for the
 * words in the prose and guess. A traceability view whose links are inferred is worse
 * than none, because the gaps are the output and a guessed edge hides one.
 */
@Injectable()
export class TraceabilityService {
  constructor(
    private readonly documents: DocumentsRepository,
    private readonly upstream: UpstreamReader,
    private readonly audit: AuditService,
  ) {}

  async view(projectId: string, correlationId: string): Promise<TraceabilityView> {
    const snapshot = await this.upstream.read(projectId, correlationId);
    const requirements = snapshot.context.requirements;
    const generatedAt = new Date().toISOString();

    if (requirements.length === 0) {
      return {
        projectId,
        baselineVersion: snapshot.context.baseline?.version ?? null,
        requirements: [],
        coverage: [],
        gaps: [],
        completeCount: 0,
        generatedAt,
      };
    }

    const approved = new Set(requirements.map((requirement) => requirement.key));
    const records = await this.documents.findAll(projectId);

    /* Each document's current content, with whether that content is still current. */
    const documents = new Map<
      DocumentType,
      {
        readonly version: number;
        readonly stale: boolean;
        readonly links: ReadonlyMap<string, TraceLink[]>;
        readonly artifacts: readonly ArtifactTrace[];
        readonly exclusions: ReadonlySet<string>;
      }
    >();

    for (const record of records) {
      const type = record.type as DocumentType;

      if (record.version === 0) {
        continue;
      }

      const state = snapshot.documentStates[type];
      const stale = state?.currentness === 'OUTDATED';

      documents.set(type, {
        version: record.version,
        stale,
        ...(await this.linksFor(projectId, type, record.version, stale, approved)),
        exclusions: new Set((record.exclusions ?? []).map((entry) => entry.requirementId)),
      });
    }

    /* ------------------------------------------------ forward: per requirement */

    const traces: RequirementTrace[] = requirements.map((requirement) => {
      const links: TraceLink[] = [];
      const missingFrom: DocumentType[] = [];
      const excludedIn: DocumentType[] = [];

      for (const type of DOCUMENT_TYPES) {
        const document = documents.get(type);

        if (!document) {
          /* Not written yet: absence is not a gap in a document that does not exist. */
          continue;
        }

        const found = document.links.get(requirement.key) ?? [];

        links.push(...found);

        if (document.exclusions.has(requirement.id) || document.exclusions.has(requirement.key)) {
          excludedIn.push(type);

          continue;
        }

        /*
         * Conditional documents are never a gap. A requirement with no assumption and
         * no client dependency is the ordinary case, and counting it would make
         * coverage a figure nobody could ever reach.
         */
        if (found.length === 0 && !isConditionalDocument(type)) {
          missingFrom.push(type);
        }
      }

      return {
        requirementKey: requirement.key,
        title: requirement.title,
        category: requirement.category,
        priority: requirement.priority,
        links,
        missingFrom,
        excludedIn,
        complete: missingFrom.length === 0,
      };
    });

    /* ------------------------------------------------------------- coverage */

    const coverage: TraceCoverageEntry[] = DOCUMENT_TYPES.map((type) => {
      const document = documents.get(type);
      const represented = traces.filter((trace) =>
        trace.links.some((link) => link.documentType === type),
      ).length;
      const excluded = traces.filter((trace) =>
        (trace.excludedIn as readonly string[]).includes(type),
      ).length;

      return {
        documentType: type,
        applicable: document ? requirements.length : 0,
        represented,
        excluded,
        conditional: isConditionalDocument(type),
        documentVersion: document?.version ?? null,
        stale: document?.stale ?? false,
      };
    });

    const gaps = [...this.gaps(traces, documents, snapshot.context.requirements)];

    /*
     * Counts only. A requirement's title is client-confidential and an audit trail is
     * read by people who were not cleared for the document; the shape of the answer is
     * what an operator needs, not its content.
     */
    await this.audit.record({
      type: 'DOCUMENT_TRACEABILITY_VIEWED',
      projectId,
      correlationId,
      metadata: {
        requirementCount: traces.length,
        completeCount: traces.filter((trace) => trace.complete).length,
        gapCount: gaps.length,
        documentsRead: documents.size,
      },
    });

    return {
      projectId,
      baselineVersion: snapshot.context.baseline?.version ?? null,
      requirements: traces,
      coverage,
      gaps,
      completeCount: traces.filter((trace) => trace.complete).length,
      generatedAt,
    };
  }

  /* ------------------------------------------------------------- the links */

  /**
   * The requirement links one document records, in both directions.
   *
   * Read from the document's own citation fields. A section keeps its references; a
   * row keeps `requirementIds`. Nothing is parsed out of prose.
   */
  private async linksFor(
    projectId: string,
    type: DocumentType,
    version: number,
    stale: boolean,
    approved: ReadonlySet<string>,
  ): Promise<{
    readonly links: ReadonlyMap<string, TraceLink[]>;
    readonly artifacts: readonly ArtifactTrace[];
  }> {
    const links = new Map<string, TraceLink[]>();
    const artifacts: ArtifactTrace[] = [];

    const add = (requirementKey: string, link: TraceLink): void => {
      links.set(requirementKey, [...(links.get(requirementKey) ?? []), link]);
    };

    const record = (
      key: string,
      label: string,
      keys: readonly string[],
      supportsDeliveryOnly = false,
    ): void => {
      for (const requirementKey of keys.filter((candidate) => approved.has(candidate))) {
        add(requirementKey, {
          documentType: type,
          documentVersion: version,
          key,
          label,
          stale,
        });
      }

      artifacts.push({
        documentType: type,
        key,
        label,
        requirementKeys: keys.filter((candidate) => approved.has(candidate)),
        danglingKeys: keys.filter((candidate) => !approved.has(candidate)),
        supportsDeliveryOnly,
      });
    };

    const sections = await this.documents.listSections(projectId, type, version);

    for (const section of sections) {
      record(
        section.key,
        section.title,
        (section.references as { kind?: string; id?: string }[])
          .filter((reference) => reference.kind === 'REQUIREMENT')
          .map((reference) => String(reference.id)),
      );
    }

    const features = await this.documents.listFeatures(projectId, type, version);

    for (const feature of features) {
      record(
        feature.featureId,
        `${feature.module} — ${feature.screen || feature.submodule || feature.description.slice(0, 60)}`,
        feature.requirementIds,
      );
    }

    const rows = await this.documents.listRows(projectId, type, version);

    for (const row of rows) {
      const payload = row.payload;
      const key =
        payloadText(payload, 'criterionKey') ||
        payloadText(payload, 'assumptionKey') ||
        payloadText(payload, 'wbsId') ||
        payloadText(payload, 'dependencyKey') ||
        row.rowId;

      const label =
        payloadText(payload, 'then') ||
        payloadText(payload, 'statement') ||
        payloadText(payload, 'task') ||
        payloadText(payload, 'dependency') ||
        '';

      /*
       * A work package classified as delivery overhead is *supposed* to cite no
       * requirement. Marked so it is not reported as an unsupported row.
       */
      const overhead =
        (payload.workKind as string | undefined) === 'OVERHEAD' ||
        (payload.level !== undefined && payload.level !== 'TASK');

      record(
        key,
        label.slice(0, 300),
        (payload.requirementIds as string[] | undefined) ?? [],
        overhead,
      );
    }

    return { links, artifacts };
  }

  /* --------------------------------------------------------------- the gaps */

  private gaps(
    traces: readonly RequirementTrace[],
    documents: ReadonlyMap<
      DocumentType,
      { readonly stale: boolean; readonly artifacts: readonly ArtifactTrace[] }
    >,
    requirements: readonly { readonly key: string; readonly category: string }[],
  ): readonly TraceGap[] {
    const gaps: TraceGap[] = [];

    const gap = (
      kind: keyof typeof TRACE_GAP_SEVERITY,
      documentType: DocumentType | null,
      summary: string,
      subjectKeys: readonly string[],
    ): void => {
      if (subjectKeys.length > 0) {
        gaps.push({
          kind,
          severity: TRACE_GAP_SEVERITY[kind],
          documentType,
          summary,
          subjectKeys: [...subjectKeys].slice(0, 200),
        });
      }
    };

    /* 1. Approved scope no feature row covers. */
    if (documents.has('FEATURE_LISTING')) {
      gap(
        'requirement_unmapped',
        'FEATURE_LISTING',
        'Approved requirements with no feature against them.',
        traces
          .filter((trace) => (trace.missingFrom as readonly string[]).includes('FEATURE_LISTING'))
          .map((trace) => trace.requirementKey),
      );
    }

    /* 2. Functional scope with no acceptance criterion. */
    if (documents.has('ACCEPTANCE_CRITERIA')) {
      const functional = new Set(
        requirements
          .filter((requirement) => requirement.category === 'functional')
          .map((requirement) => requirement.key),
      );

      gap(
        'feature_without_criterion',
        'ACCEPTANCE_CRITERIA',
        'Functional requirements with no acceptance condition.',
        traces
          .filter(
            (trace) =>
              functional.has(trace.requirementKey) &&
              (trace.missingFrom as readonly string[]).includes('ACCEPTANCE_CRITERIA'),
          )
          .map((trace) => trace.requirementKey),
      );
    }

    /* 3. Approved scope absent from the plan. */
    if (documents.has('WORK_BREAKDOWN_STRUCTURE')) {
      gap(
        'scope_without_work',
        'WORK_BREAKDOWN_STRUCTURE',
        'Approved requirements with no work package against them.',
        traces
          .filter((trace) =>
            (trace.missingFrom as readonly string[]).includes('WORK_BREAKDOWN_STRUCTURE'),
          )
          .map((trace) => trace.requirementKey),
      );
    }

    /* 4 and 5. Rows supporting nothing, and citations naming nothing. */
    for (const [type, document] of documents) {
      gap(
        'unsupported_row',
        type,
        `Entries in ${DOCUMENT_LABELS[type]} that cite no approved requirement.`,
        document.artifacts
          .filter(
            (artifact) =>
              !artifact.supportsDeliveryOnly &&
              artifact.requirementKeys.length === 0 &&
              artifact.danglingKeys.length === 0,
          )
          .map((artifact) => artifact.key),
      );

      gap(
        'dangling_reference',
        type,
        `Entries in ${DOCUMENT_LABELS[type]} citing a requirement the approved baseline does not contain.`,
        [...new Set(document.artifacts.flatMap((artifact) => artifact.danglingKeys))],
      );

      if (document.stale) {
        gap('stale_trace', type, `${DOCUMENT_LABELS[type]} is no longer current.`, [type]);
      }
    }

    return gaps;
  }

  /* -------------------------------------------- reverse: one artifact back */

  /**
   * The requirements behind one row or section.
   *
   * The direction somebody uses looking at a work package and asking why it exists.
   * Dependencies additionally name the work they wait on, which is checked here so a
   * sheet pointing at work that no longer exists is reported rather than rendered as a
   * dead link.
   */
  async reverse(
    projectId: string,
    type: DocumentType,
    correlationId: string,
  ): Promise<readonly ArtifactTrace[]> {
    const snapshot = await this.upstream.read(projectId, correlationId);
    const record = await this.documents.find(projectId, type);

    if (!record || record.version === 0) {
      return [];
    }

    const approved = new Set(snapshot.context.requirements.map((requirement) => requirement.key));
    const state = snapshot.documentStates[type];

    const { artifacts } = await this.linksFor(
      projectId,
      type,
      record.version,
      state?.currentness === 'OUTDATED',
      approved,
    );

    if (type !== 'CLIENT_DEPENDENCY_SHEET') {
      return artifacts;
    }

    /* A dependency's other edge: the work packages it names. */
    const breakdown = await this.documents.find(projectId, 'WORK_BREAKDOWN_STRUCTURE');

    const knownWbsIds = breakdown
      ? new Set(
          (
            await this.documents.listRows(projectId, 'WORK_BREAKDOWN_STRUCTURE', breakdown.version)
          ).map((row) => (row.payload as unknown as WorkPackage).wbsId),
        )
      : new Set<string>();

    const rows = await this.documents.listRows(projectId, type, record.version);

    return artifacts.map((artifact) => {
      const dependency = rows
        .map((row) => row.payload as unknown as ClientDependency)
        .find((candidate) => candidate.dependencyKey === artifact.key);

      const dangling = (dependency?.wbsIds ?? []).filter((id) => !knownWbsIds.has(id));

      return dangling.length > 0
        ? { ...artifact, danglingKeys: [...artifact.danglingKeys, ...dangling] }
        : artifact;
    });
  }
}
