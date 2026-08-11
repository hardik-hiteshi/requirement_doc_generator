/**
 * The shape of an Our Understanding document.
 *
 * ## What this document is for
 *
 * One sentence: *before anybody estimates or builds anything further, this is our
 * formal understanding of what you need.* It is the artifact that turns a pile of
 * approved requirements into something a client can read and say "yes, that is
 * what we asked for" — or, more valuably, "no, and here is what you missed".
 *
 * ## Why sections are a template rather than a model's choice
 *
 * A document whose headings vary per project cannot be compared across projects,
 * reviewed against a checklist, or explained to a client. So the sections are
 * fixed here, and the model writes *into* them. It cannot add a section, drop
 * one, or reorder them.
 *
 * ## Why some sections are allowed to be empty
 *
 * Most of these headings must not appear as filler. A project with no
 * integrations has nothing to say under Integrations, and the generated
 * temptation is to write "the system will integrate with third-party services as
 * required" — a sentence that means nothing and that a client may later hold
 * somebody to. So a section with no supporting evidence is kept as an empty
 * section carrying a reason, which reads honestly and is visibly different from a
 * heading nobody remembered.
 *
 * `requiresEvidence` marks the sections that may only exist if the approved
 * baseline actually says something. `alwaysPresent` marks the two that a document
 * is meaningless without.
 */

export interface UnderstandingSectionDefinition {
  readonly key: string;
  readonly title: string;
  readonly order: number;
  /** What belongs here, in the writer's terms. Feeds the prompt. */
  readonly guidance: string;
  /** Omitted with a reason when the baseline supports nothing. */
  readonly requiresEvidence: boolean;
  /** Categories of requirement that supply this section, when applicable. */
  readonly sourceCategories?: readonly string[];
}

export const UNDERSTANDING_SECTIONS: readonly UnderstandingSectionDefinition[] = [
  {
    key: 'project-overview',
    title: 'Project Overview',
    order: 1,
    guidance:
      'What is being built, in two or three sentences a non-technical reader understands. Name the kind of system and who it is for.',
    requiresEvidence: false,
  },
  {
    key: 'business-objective',
    title: 'Business Objective',
    order: 2,
    guidance:
      'The outcome the client is trying to achieve. Only what the requirements state — never an inferred commercial goal.',
    requiresEvidence: true,
  },
  {
    key: 'solution-understanding',
    title: 'Solution Understanding',
    order: 3,
    guidance:
      'How the system answers that objective, at the level of capability rather than implementation. No architecture, no library names.',
    requiresEvidence: false,
  },
  {
    key: 'intended-users',
    title: 'Intended Users and Roles',
    order: 4,
    guidance:
      'The roles the requirements name, and what each of them does. Do not invent an administrator nobody mentioned.',
    requiresEvidence: true,
  },
  {
    key: 'major-modules',
    title: 'Major Modules',
    order: 5,
    guidance:
      'The functional areas the requirements group into. Each named area must trace to requirements.',
    requiresEvidence: true,
  },
  {
    key: 'core-workflows',
    title: 'Core Workflows',
    order: 6,
    guidance:
      'The end-to-end journeys, in order of steps. A workflow the requirements do not describe does not belong here.',
    requiresEvidence: true,
  },
  {
    key: 'functional-scope',
    title: 'Key Functional Scope',
    order: 7,
    guidance:
      'What the system will do, as a list a client can check off. Every entry cites the requirements behind it.',
    requiresEvidence: true,
    sourceCategories: ['FUNCTIONAL'],
  },
  {
    key: 'non-functional',
    title: 'Explicit Non-Functional Requirements',
    order: 8,
    guidance:
      'Only stated quality requirements, with their stated figures. No invented target of any kind — no throughput, no uptime, no response time.',
    requiresEvidence: true,
    sourceCategories: ['NON_FUNCTIONAL'],
  },
  {
    key: 'integrations',
    title: 'Integrations',
    order: 9,
    guidance:
      'External systems the requirements name, and what flows to or from each. Never a generic integration sentence.',
    requiresEvidence: true,
    sourceCategories: ['INTEGRATION'],
  },
  {
    key: 'data-reporting',
    title: 'Data and Reporting Requirements',
    order: 10,
    guidance: 'Data the system holds and reports the requirements ask for.',
    requiresEvidence: true,
    sourceCategories: ['DATA', 'REPORTING'],
  },
  {
    key: 'platforms',
    title: 'Platforms',
    order: 11,
    guidance:
      'Where the system runs, as the requirements state it. A web application is not also a mobile app because it would be nice.',
    requiresEvidence: true,
  },
  {
    key: 'constraints',
    title: 'Constraints',
    order: 12,
    guidance: 'Stated limits: timeline, regulatory, technical, organisational.',
    requiresEvidence: true,
    sourceCategories: ['CONSTRAINT'],
  },
  {
    key: 'out-of-scope',
    title: 'Explicitly Out of Scope',
    order: 13,
    guidance:
      'What the requirements say is not included. This section protects both sides and must never be softened.',
    requiresEvidence: true,
  },
  {
    key: 'clarifications',
    title: 'Confirmed Clarifications',
    order: 14,
    guidance:
      'Questions asked and the answers confirmed, because those answers are now part of the agreement.',
    requiresEvidence: true,
  },
  {
    key: 'open-items',
    title: 'Open Items',
    order: 15,
    guidance:
      'Non-blocking questions still outstanding. Present only when some remain — an empty "none outstanding" reads as a claim.',
    requiresEvidence: true,
  },
] as const;

export const UNDERSTANDING_SECTION_KEYS = UNDERSTANDING_SECTIONS.map((section) => section.key);

/** Sections a document cannot be approved without. */
export const REQUIRED_UNDERSTANDING_KEYS: readonly string[] = [
  'project-overview',
  'functional-scope',
];

export function understandingSection(key: string): UnderstandingSectionDefinition | undefined {
  return UNDERSTANDING_SECTIONS.find((section) => section.key === key);
}

/**
 * Things a client-facing document must never contain.
 *
 * Two groups, and they are here for different reasons.
 *
 * **Invented specifics.** A target nobody agreed to — "99.9% uptime", "supports
 * 10,000 concurrent users", "GDPR compliant", "WCAG 2.1 AA" — is a commitment
 * created by a language model and signed by a company. These are the exact
 * phrases such a model reaches for when a section looks thin, which is why they
 * are checked for rather than merely discouraged in a prompt.
 *
 * **Internal methodology.** How the work gets done is not the client's document.
 * AI-assisted development, the productivity model, the deterministic engine —
 * none of it belongs in a statement of what the client needs, and the standing
 * instruction across this project is that it never appears unless explicitly
 * enabled.
 */
export const FORBIDDEN_UNDERSTANDING_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly reason: string;
}[] = [
  {
    pattern: /\b\d{1,2}(\.\d+)?\s*%\s*(uptime|availability|sla)\b/i,
    reason: 'an availability target the requirements do not state',
  },
  {
    pattern: /\b(\d[\d,]*)\s*(concurrent|simultaneous)\s+(users|sessions|requests)\b/i,
    reason: 'a user-volume figure the requirements do not state',
  },
  {
    pattern: /\bsub-?second|\b\d+\s*ms\s+response\b/i,
    reason: 'a performance target the requirements do not state',
  },
  {
    pattern: /\b(gdpr|hipaa|pci[- ]?dss|soc\s?2|iso\s?27001)\b/i,
    reason: 'a compliance regime the requirements do not state',
  },
  {
    pattern: /\bwcag\b|\bsection\s?508\b/i,
    reason: 'an accessibility standard the requirements do not state',
  },
  {
    pattern: /\b(vibe[- ]cod|ai[- ]assisted (development|coding)|copilot|llm|language model)\b/i,
    reason: 'internal development methodology, which is not part of a client document',
  },
  {
    pattern:
      /\b(industry[- ]leading|cutting[- ]edge|state[- ]of[- ]the[- ]art|best[- ]in[- ]class|seamless(ly)?|robust and scalable)\b/i,
    reason: 'marketing language, which this document does not use',
  },
  {
    pattern: /\b(as required|as needed|etc\.|and more|among others)\s*[.,;]/i,
    reason: 'a vague catch-all that leaves scope undefined',
  },
];

/**
 * Forbidden content found in a body of text.
 *
 * Reported as findings rather than stripped. Deleting the sentence would hide
 * that the model tried to invent a commitment, and a reviewer who cannot see the
 * attempt cannot judge whether the rest of the section is sound.
 */
export function forbiddenContent(
  body: string,
): readonly { readonly match: string; readonly reason: string }[] {
  const found: { match: string; reason: string }[] = [];

  for (const { pattern, reason } of FORBIDDEN_UNDERSTANDING_PATTERNS) {
    const match = pattern.exec(body);

    if (match) {
      found.push({ match: match[0], reason });
    }
  }

  return found;
}
