import type {
  AcceptanceCriterion,
  Assumption,
  DocumentReference,
  DocumentRow,
  DocumentShape,
  DocumentType,
  EstimateUnit,
  FeatureRow,
  RequirementItem,
  SowTimeline,
  ValidationFinding,
} from '@wdrg/contracts';

/**
 * What every document composer is given, and what it must return.
 *
 * The interface is the point of Phase 7. A composer knows how to turn approved
 * upstream artifacts into one document's content and how to check that content
 * against them. Everything else — status transitions, versioning, edit
 * protection, proposals, outdated propagation, approval, audit, storage — belongs
 * to the engine and is written once.
 *
 * Adding Acceptance Criteria in a later phase is a new composer and a row in the
 * dependency table. It is not a new service, a new controller, a new repository
 * or a new set of endpoints, and that is the difference between a document engine
 * and five copies of one.
 *
 * ## Composers are deterministic
 *
 * `compose` takes no provider and cannot make a network call. It produces a
 * complete, honest document from the approved artifacts alone — headings, the
 * requirements each one covers, the feature rows with their hours from the
 * estimate. That is what makes `AI_PROVIDER=disabled` a working configuration
 * rather than a degraded one: the model's contribution is prose *inside* a
 * structure the application already decided, and prose is the part a person can
 * write themselves.
 */

/**
 * The upstream artifacts, in the shape a composer needs them.
 *
 * Deliberately narrower than the Phase 4/5/6 snapshot contracts: a composer needs
 * an id, a version and the content, and coupling it to three full snapshot shapes
 * would make every change upstream a change here.
 */
export interface UpstreamArtifact {
  readonly id: string;
  readonly version: number;
  readonly status: string;
}

export interface UpstreamBaseline extends UpstreamArtifact {
  readonly itemIds: readonly string[];
}

export interface UpstreamStack extends UpstreamArtifact {
  readonly components: readonly {
    readonly category: string;
    readonly technologyId?: string;
    readonly technologyName: string;
    readonly status: string;
  }[];
}

/** Every approved upstream artifact, read once per operation. */
export interface UpstreamContext {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectTypes: readonly string[];
  readonly baseline: UpstreamBaseline | null;
  /** Requirements in the approved baseline. Rejected and superseded excluded. */
  readonly requirements: readonly RequirementItem[];
  /** Every requirement, including rejected ones — validation needs to see them. */
  readonly allRequirements: readonly RequirementItem[];
  /** Settled clarifications, as question/answer pairs. */
  readonly clarifications: readonly {
    readonly id: string;
    readonly label: string;
    readonly question: string;
    readonly answer: string;
    /**
     * Whether the person answering said this was an assumption rather than a
     * fact the client stated. Phase 4 required them to choose, so this is a
     * recorded decision rather than an inference.
     */
    readonly isAssumption: boolean;
    /** Whether the answer has been confirmed as the client's. */
    readonly confirmed: boolean;
  }[];
  readonly stack: UpstreamStack | null;
  readonly estimate: UpstreamArtifact | null;
  readonly estimateUnits: readonly EstimateUnit[];
  /** Blocking issues upstream that a document must not conceal. */
  readonly upstreamBlockers: readonly { readonly kind: string; readonly summary: string }[];
  /**
   * The approved schedule, in the terms a document may quote.
   *
   * Null when no estimate is approved. `basis` is the important part: it decides
   * whether a document may name a date at all, and it comes from Phase 6 rather
   * than from a composer's guess about whether a start date exists.
   */
  readonly timeline: SowTimeline | null;
  /**
   * Content of the documents before this one, and only where they are authority.
   *
   * A prerequisite appears here **only** when it is approved and current — the
   * reader applies `isAuthoritativeState` before filling these in. So a composer
   * cannot accidentally build on a draft or a stale document: there is nothing to
   * build on. That is the sequential rule expressed as data rather than as a check
   * every composer would have to remember.
   */
  readonly documents: UpstreamDocuments;
}

/** Approved, current content from the documents earlier in the sequence. */
export interface UpstreamDocuments {
  readonly understanding: {
    readonly version: number;
    readonly sections: readonly {
      readonly key: string;
      readonly title: string;
      readonly body: string;
    }[];
  } | null;
  readonly featureListing: {
    readonly version: number;
    readonly features: readonly FeatureRow[];
    /** Requirements deliberately left out of the listing. */
    readonly excludedRequirementIds: readonly string[];
  } | null;
  readonly acceptanceCriteria: {
    readonly version: number;
    readonly criteria: readonly AcceptanceCriterion[];
  } | null;
  readonly assumptions: {
    readonly version: number;
    /** Every assumption, whatever its state — validation needs to see them all. */
    readonly assumptions: readonly Assumption[];
  } | null;
}

/** One composed section, before the engine assigns ids and origins. */
export interface ComposedSection {
  readonly key: string;
  readonly title: string;
  readonly order: number;
  readonly body: string;
  /** Set when the evidence supports nothing, instead of writing filler. */
  readonly omittedReason?: string;
  readonly references: readonly DocumentReference[];
}

/** One composed row, before the engine assigns an id and an origin. */
export interface ComposedRow {
  readonly order: number;
  readonly references: readonly DocumentReference[];
  /** The document-specific content, already valid against its own schema. */
  readonly payload: Record<string, unknown>;
}

/**
 * Composed content. A composer fills the channel its shape calls for.
 *
 * `sections` for prose, `features` for the Feature Listing, `rows` for every other
 * list document. A composer leaves the others empty.
 */
export interface ComposedContent {
  readonly sections: readonly ComposedSection[];
  readonly features: readonly Omit<FeatureRow, 'featureId'>[];
  readonly rows: readonly ComposedRow[];
}

export interface ValidationInput {
  readonly context: UpstreamContext;
  /**
   * Sections with the citations the application recorded for them.
   *
   * Coverage is checked against `references`, not against ids scraped from the
   * prose. A client-facing document does not carry requirement ids in its text —
   * and once a model has rewritten a section, there are none there to find, so a
   * scrape would report every requirement as uncovered.
   *
   * The prose is still read, for the opposite purpose: an id that appears in it and
   * is *not* in the baseline is a fabricated citation, and that has to be caught
   * wherever it turns up.
   */
  readonly sections: readonly {
    readonly key: string;
    readonly body: string;
    readonly references: readonly string[];
  }[];
  readonly features: readonly FeatureRow[];
  /** Structured rows as stored, with their origin and any pending proposal. */
  readonly rows: readonly DocumentRow[];
  /** Requirements a person deliberately left out of this document. */
  readonly excludedRequirementIds: readonly string[];
  /** Whether the document was written against the current baseline. */
  readonly baselineCurrent: boolean;
}

export interface DocumentComposer {
  readonly type: DocumentType;
  readonly shape: DocumentShape;
  /** Section keys a document of this type cannot be approved without. */
  readonly requiredSectionKeys: readonly string[];
  /**
   * The row kind this document is a list of, for a `ROWS` document that uses the
   * generic row channel. Absent for prose documents and for Feature Listing,
   * which has its own storage.
   */
  readonly rowKind?: DocumentRow['kind'];

  /**
   * The document, assembled from approved artifacts and nothing else.
   *
   * No model, no network, no clock beyond what the engine supplies. Given the
   * same upstream state it returns the same content, which is what makes the
   * integration suite able to assert on it.
   */
  compose(context: UpstreamContext): ComposedContent;

  /**
   * Deterministic findings. Authoritative, and never overridden by a model.
   *
   * Returns `PASS` entries as well as problems: "coverage is complete" is a more
   * useful record than the absence of a coverage finding.
   */
  validate(input: ValidationInput): readonly ValidationFinding[];

  /** Requirements this document is answerable for. Drives coverage. */
  applicableRequirementIds(context: UpstreamContext): readonly string[];
}

/** Which estimate units support a requirement. Shared by composers. */
export function unitsForRequirements(
  units: readonly EstimateUnit[],
  requirementIds: readonly string[],
): readonly EstimateUnit[] {
  const wanted = new Set(requirementIds);

  return units.filter((unit) => !unit.excluded && unit.requirementIds.some((id) => wanted.has(id)));
}

/**
 * A citation for a requirement, carrying its source location when it has one.
 *
 * The location is *copied* from the requirement's own traceability link, which
 * Phase 4 verified against the extracted block. Nothing here constructs a page
 * number, and nothing accepts one from a model.
 */
export function requirementReference(requirement: RequirementItem): DocumentReference {
  const link = requirement.references.find((candidate) => candidate.verified);
  const reference = link?.reference;

  return {
    kind: 'REQUIREMENT',
    id: requirement.key,
    label: requirement.title,
    ...(link ? { sourceId: link.sourceId } : {}),
    ...(reference?.pageNumber ? { pageNumber: reference.pageNumber } : {}),
    ...(reference?.lineNumber ? { lineNumber: reference.lineNumber } : {}),
    ...(reference?.sheetName ? { sheetName: reference.sheetName } : {}),
    ...(reference?.cellRange ? { cellRange: reference.cellRange } : {}),
  };
}
