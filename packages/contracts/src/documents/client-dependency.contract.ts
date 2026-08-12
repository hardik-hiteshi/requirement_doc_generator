import { z } from 'zod';

/**
 * Client Dependency Sheet — Document 7.
 *
 * ## Only what somebody outside the delivery team has to provide
 *
 * A sheet that lists every internal task dependency is a project plan with the wrong
 * title, and a client reading it learns nothing they can act on. This document
 * answers one question: what do we need from you, and by when?
 *
 * So a row needs an *external* actor — the client, one of their stakeholders, a
 * provider they control, or an approver outside the team. `isClientFacing` decides
 * that from the category, and an internal sequencing dependency has no category here
 * to hide behind.
 *
 * ## Grounded, or it does not exist
 *
 * "Client must provide all required information" is not a dependency; it is a
 * sentence that will never be actioned and can never be closed. Every row records
 * the authority it came from — an integration in the approved baseline, a client
 * assumption somebody confirmed, an unanswered clarification, a locked technology
 * that needs credentials, the SOW's own dependency section, or a WBS task that
 * cannot start without it — and `sourceKindSchema` has no value meaning "general".
 *
 * ## Received is not accepted
 *
 * The status lifecycle keeps them apart deliberately. Credentials arrive and do not
 * work; a data file arrives in the wrong encoding; an approval arrives from somebody
 * without the authority to give it. `RECEIVED` means it turned up. `ACCEPTED` means
 * somebody checked. Collapsing the two is how a project believes it is unblocked for
 * a fortnight.
 *
 * ## Credentials are recorded, never stored
 *
 * A row about credentials records *that* credentials are needed, requested, received
 * and validated. It never carries the value. `looksLikeSecret` refuses text that
 * appears to be one, because a sheet like this gets emailed, exported and pasted into
 * chat — and a secret in it is a secret in all of those places.
 */

/* ------------------------------------------------------------ category */

export const CLIENT_DEPENDENCY_CATEGORIES = [
  'ACCESS',
  'CREDENTIALS',
  'API_DOCUMENTATION',
  'CONTENT',
  'DATA',
  'DESIGN_ASSET',
  'INFRASTRUCTURE',
  'ENVIRONMENT',
  'THIRD_PARTY',
  'APPROVAL',
  'REVIEW',
  'UAT',
  'LEGAL_OR_COMPLIANCE',
  'BUSINESS_DECISION',
  'OTHER',
] as const;

export type ClientDependencyCategory = (typeof CLIENT_DEPENDENCY_CATEGORIES)[number];
export const clientDependencyCategorySchema = z.enum(CLIENT_DEPENDENCY_CATEGORIES);

export const CLIENT_DEPENDENCY_CATEGORY_LABELS: Readonly<Record<ClientDependencyCategory, string>> =
  {
    ACCESS: 'Access',
    CREDENTIALS: 'Credentials',
    API_DOCUMENTATION: 'API documentation',
    CONTENT: 'Content',
    DATA: 'Data',
    DESIGN_ASSET: 'Design asset',
    INFRASTRUCTURE: 'Infrastructure',
    ENVIRONMENT: 'Environment',
    THIRD_PARTY: 'Third party',
    APPROVAL: 'Approval',
    REVIEW: 'Review',
    UAT: 'User acceptance testing',
    LEGAL_OR_COMPLIANCE: 'Legal or compliance',
    BUSINESS_DECISION: 'Business decision',
    OTHER: 'Other',
  };

/**
 * Whether this category describes something only somebody outside the team can do.
 *
 * All of them do, which is the point: there is no category for "internal sequencing",
 * so an internal dependency cannot be filed here at all.
 */
export function isClientFacing(category: ClientDependencyCategory): boolean {
  return (CLIENT_DEPENDENCY_CATEGORIES as readonly string[]).includes(category);
}

/* ----------------------------------------------------------- provenance */

/** What makes this a real dependency rather than a generality. */
export const DEPENDENCY_SOURCE_KINDS = [
  'REQUIREMENT_BASELINE',
  'TECHNOLOGY_STACK',
  'FEATURE_LISTING',
  'APPROVED_ASSUMPTION',
  'STATEMENT_OF_WORK',
  'WBS_TASK',
  'OPEN_CLARIFICATION',
  /** A person added it and said why. Attributable, and marked as theirs. */
  'USER_STATED',
] as const;

export type DependencySourceKind = (typeof DEPENDENCY_SOURCE_KINDS)[number];
export const dependencySourceKindSchema = z.enum(DEPENDENCY_SOURCE_KINDS);

export const DEPENDENCY_SOURCE_LABELS: Readonly<Record<DependencySourceKind, string>> = {
  REQUIREMENT_BASELINE: 'an approved requirement',
  TECHNOLOGY_STACK: 'the locked technology stack',
  FEATURE_LISTING: 'the approved feature listing',
  APPROVED_ASSUMPTION: 'a confirmed assumption',
  STATEMENT_OF_WORK: 'the statement of work',
  WBS_TASK: 'a task in the work breakdown',
  OPEN_CLARIFICATION: 'an unanswered clarification',
  USER_STATED: 'you',
};

/* -------------------------------------------------------------- status */

export const DEPENDENCY_STATUSES = [
  'NOT_REQUESTED',
  'REQUESTED',
  'PARTIALLY_RECEIVED',
  /** It turned up. Nobody has checked it yet. */
  'RECEIVED',
  'VALIDATING',
  /** Checked, and it works. Only this unblocks the work. */
  'ACCEPTED',
  'REJECTED',
  /** Agreed to be unnecessary after all. */
  'WAIVED',
  'SUPERSEDED',
] as const;

export type DependencyStatus = (typeof DEPENDENCY_STATUSES)[number];
export const dependencyStatusSchema = z.enum(DEPENDENCY_STATUSES);

export const DEPENDENCY_STATUS_LABELS: Readonly<Record<DependencyStatus, string>> = {
  NOT_REQUESTED: 'Not requested yet',
  REQUESTED: 'Requested',
  PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received, not checked',
  VALIDATING: 'Being checked',
  ACCEPTED: 'Received and working',
  REJECTED: 'Not usable',
  WAIVED: 'No longer needed',
  SUPERSEDED: 'Replaced',
};

/**
 * The moves a person may make, and the one they may not.
 *
 * Nothing goes from `RECEIVED` straight to a state that unblocks work without
 * passing through a check. `ACCEPTED` is reachable only from `VALIDATING` or
 * `RECEIVED` — and in the second case the act of accepting *is* the check, recorded
 * as a decision somebody made.
 */
export const DEPENDENCY_TRANSITIONS: Readonly<
  Record<DependencyStatus, readonly DependencyStatus[]>
> = {
  NOT_REQUESTED: ['REQUESTED', 'WAIVED', 'SUPERSEDED'],
  REQUESTED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'WAIVED', 'SUPERSEDED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'REJECTED', 'WAIVED', 'SUPERSEDED'],
  RECEIVED: ['VALIDATING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED'],
  VALIDATING: ['ACCEPTED', 'REJECTED', 'SUPERSEDED'],
  ACCEPTED: ['SUPERSEDED'],
  REJECTED: ['REQUESTED', 'WAIVED', 'SUPERSEDED'],
  WAIVED: ['REQUESTED'],
  SUPERSEDED: [],
};

export function canTransitionDependency(from: DependencyStatus, to: DependencyStatus): boolean {
  return DEPENDENCY_TRANSITIONS[from].includes(to);
}

/** Whether the work waiting on this may proceed. Only a checked item counts. */
export function isDependencySatisfied(status: DependencyStatus): boolean {
  return status === 'ACCEPTED' || status === 'WAIVED';
}

/* -------------------------------------------------------------- priority */

export const DEPENDENCY_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export type DependencyPriority = (typeof DEPENDENCY_PRIORITIES)[number];

export const DEPENDENCY_PRIORITY_LABELS: Readonly<Record<DependencyPriority, string>> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

/** What the delay of this item stops. Grounded, never assumed. */
export const BLOCKING_SCOPES = [
  'NONE',
  'TASK',
  'FEATURE',
  'MILESTONE',
  'TESTING',
  'UAT',
  'RELEASE',
] as const;

export type BlockingScope = (typeof BLOCKING_SCOPES)[number];

export const BLOCKING_SCOPE_LABELS: Readonly<Record<BlockingScope, string>> = {
  NONE: 'Nothing is waiting on this',
  TASK: 'A task cannot start',
  FEATURE: 'A feature cannot be finished',
  MILESTONE: 'A milestone cannot be met',
  TESTING: 'Testing cannot proceed',
  UAT: 'User acceptance testing cannot start',
  RELEASE: 'The release is at risk',
};

/* ------------------------------------------------------ secret hygiene */

/**
 * Whether a piece of text looks like a credential rather than a description of one.
 *
 * Deliberately shape-based. A row about credentials is legitimate and common — "the
 * sandbox API key for the payment provider" — and what must never appear is the key
 * itself. This sheet is exported, emailed and pasted into chat, so a secret in it is
 * a secret in all of those places, and once it is in a document version it is in the
 * history for good.
 *
 * Erring towards refusal: a false positive costs somebody a rewording, and a false
 * negative leaks a live credential into an immutable record.
 */
export const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/i, label: 'an API key' },
  { pattern: /\bAKIA[0-9A-Z]{12,}/, label: 'an AWS access key' },
  { pattern: /\bghp_[A-Za-z0-9]{20,}/, label: 'a GitHub token' },
  { pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, label: 'a JWT' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'a private key' },
  {
    pattern:
      /\b(password|passwd|pwd|secret|api[_-]?key|token|client[_-]?secret)\b\s*[:=]\s*\S{6,}/i,
    label: 'a credential value',
  },
  { pattern: /\b[a-z0-9+/]{40,}={0,2}\b/, label: 'an encoded secret' },
  {
    pattern: /\b(mongodb|postgres|postgresql|mysql|redis|amqp):\/\/[^\s]*:[^\s]*@/i,
    label: 'a connection string with a password',
  },
];

export function looksLikeSecret(text: string): readonly string[] {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

/* ------------------------------------------------------------ the row */

export const clientDependencySchema = z
  .object({
    /** Human-facing identifier, `CD-001`. Assigned by the application. */
    dependencyKey: z.string().regex(/^CD-\d{3,5}$/, 'A client dependency is keyed CD-001'),
    category: clientDependencyCategorySchema,
    module: z.string().max(200),
    feature: z.string().max(300),

    /** What is needed, in one line a client can act on. */
    dependency: z.string().min(1).max(300),
    description: z.string().max(2_000),
    /** Why it is needed, which is what makes it arguable rather than arbitrary. */
    purpose: z.string().max(1_000),

    /* Where it comes from. At least one, and never "general". */
    sourceKinds: z.array(dependencySourceKindSchema).min(1).max(8),
    requirementIds: z.array(z.string().max(64)).max(60),
    featureIds: z.array(z.string().max(64)).max(60),
    /** WBS rows that cannot proceed without it. */
    wbsIds: z.array(z.string().max(64)).max(60),
    technologyIds: z.array(z.string().max(64)).max(40),

    /* Who. Never invented — a role where the role is known, blank otherwise. */
    clientOwner: z.string().max(200),
    internalOwner: z.string().max(200),

    /* When. Relative unless the approved plan carries real dates. */
    /** Milestone or phase this is needed for. */
    requiredForMilestoneId: z.string().max(64).optional(),
    /** "before integration development", "by working day 12". */
    relativeDue: z.string().max(200),
    /** Only when the approved schedule has calendar dates. */
    actualDueDate: z.string().max(10).optional(),

    priority: z.enum(DEPENDENCY_PRIORITIES),
    blocking: z.enum(BLOCKING_SCOPES),
    /** In words. No fabricated cost or delay figures. */
    impactIfDelayed: z.string().max(1_000),
    /** What good looks like: a format, a scope, an environment. */
    expectedFormat: z.string().max(500),

    status: dependencyStatusSchema,
    requestedAt: z.string().datetime().optional(),
    receivedAt: z.string().datetime().optional(),
    /** What the check found. Set when it moves to ACCEPTED or REJECTED. */
    validationNote: z.string().max(1_000),
    validatedAt: z.string().datetime().optional(),

    /**
     * True when this is about credentials.
     *
     * The row then records the *need* and its state. The value never appears — see
     * `looksLikeSecret`, which is enforced on every text field before storage.
     */
    credentialsRequired: z.boolean(),
    remarks: z.string().max(1_000),
  })
  .strict();

export type ClientDependency = z.infer<typeof clientDependencySchema>;

/** Every text field a person or a model could put a secret into. */
export function dependencyTextFields(dependency: ClientDependency): readonly string[] {
  return [
    dependency.dependency,
    dependency.description,
    dependency.purpose,
    dependency.expectedFormat,
    dependency.impactIfDelayed,
    dependency.validationNote,
    dependency.remarks,
    dependency.clientOwner,
    dependency.internalOwner,
  ];
}

/** Secrets found anywhere in a row. */
export function secretsInDependency(dependency: ClientDependency): readonly string[] {
  return [...new Set(dependencyTextFields(dependency).flatMap(looksLikeSecret))];
}

/**
 * Whether two rows are the same request.
 *
 * Compared on the category and the normalised request. The same thing asked for
 * twice, once per feature, is one dependency with two features attached — and a sheet
 * that lists it twice gets chased twice.
 */
export function dependencyFingerprint(
  dependency: Pick<ClientDependency, 'category' | 'dependency'>,
): string {
  return [
    dependency.category,
    dependency.dependency
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ].join('|');
}

/**
 * Phrases too vague to be a dependency.
 *
 * Each is a sentence nobody can action and nobody can close. They are refused rather
 * than warned about, because a sheet with three of these at the top is a sheet that
 * gets ignored.
 */
export const VAGUE_DEPENDENCY_PATTERNS: readonly RegExp[] = [
  /^(the )?client (must|should|will) provide (all|any|the) (required |necessary )?(information|details|data|inputs)\.?$/i,
  /^(all|any) (required|necessary) (information|details|inputs|approvals)\.?$/i,
  /^(timely )?(client )?(cooperation|collaboration|engagement|availability)\.?$/i,
  /^(as )?(and when )?required\.?$/i,
  /^(client )?(sign[- ]?off|approval)\.?$/i,
];

export function isTooVague(dependency: string): boolean {
  return VAGUE_DEPENDENCY_PATTERNS.some((pattern) => pattern.test(dependency.trim()));
}

/** The next free `CD-nnn`. */
export function nextDependencyKey(existing: readonly string[]): string {
  const highest = existing.reduce((best, key) => {
    const match = /^CD-(\d{3,5})$/.exec(key);

    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);

  return `CD-${String(highest + 1).padStart(3, '0')}`;
}

/* -------------------------------------------------------------- summary */

export const dependencySummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    outstanding: z.number().int().nonnegative(),
    received: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    /** Blocking and not yet satisfied. The list somebody chases. */
    blockingOutstanding: z.array(z.string().max(64)).max(200),
    byCategory: z.record(z.string().max(40), z.number().int().nonnegative()),
  })
  .strict();

export type DependencySummary = z.infer<typeof dependencySummarySchema>;

export function summariseDependencies(
  dependencies: readonly Pick<
    ClientDependency,
    'dependencyKey' | 'status' | 'category' | 'blocking'
  >[],
): DependencySummary {
  const byCategory: Record<string, number> = {};

  for (const dependency of dependencies) {
    byCategory[dependency.category] = (byCategory[dependency.category] ?? 0) + 1;
  }

  return {
    total: dependencies.length,
    outstanding: dependencies.filter((entry) => !isDependencySatisfied(entry.status)).length,
    received: dependencies.filter((entry) => entry.status === 'RECEIVED').length,
    accepted: dependencies.filter((entry) => entry.status === 'ACCEPTED').length,
    rejected: dependencies.filter((entry) => entry.status === 'REJECTED').length,
    blockingOutstanding: dependencies
      .filter((entry) => entry.blocking !== 'NONE' && !isDependencySatisfied(entry.status))
      .map((entry) => entry.dependencyKey),
    byCategory,
  };
}

/* --------------------------------------------------------- write shapes */

/**
 * What a model may return for a client dependency.
 *
 * No owner, no date, no status, no blocking classification — every field that would
 * commit somebody or unblock something. It may say what appears to be needed, why,
 * and which approved scope suggests it; the application decides whether that is
 * grounded, and a person decides who is doing it and by when.
 */
export const clientDependencyDraftSchema = z
  .object({
    category: clientDependencyCategorySchema,
    dependency: z.string().min(1).max(300),
    description: z.string().max(2_000),
    purpose: z.string().max(1_000),
    /** Requirement keys the need follows from. Verified before storage. */
    requirementKeys: z.array(z.string().max(64)).max(20),
    expectedFormat: z.string().max(500),
    impactIfDelayed: z.string().max(1_000),
  })
  .strict();

export type ClientDependencyDraft = z.infer<typeof clientDependencyDraftSchema>;

export const requestDependencySchema = z
  .object({
    note: z.string().max(1_000).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type RequestDependency = z.infer<typeof requestDependencySchema>;

export const receiveDependencySchema = z
  .object({
    /** Partly, or in full. */
    partial: z.boolean(),
    note: z.string().max(1_000).optional(),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ReceiveDependency = z.infer<typeof receiveDependencySchema>;

export const validateDependencySchema = z
  .object({
    outcome: z.enum(['ACCEPTED', 'REJECTED']),
    /** What was checked, and what it showed. Required either way. */
    note: z.string().min(1).max(1_000),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export type ValidateDependency = z.infer<typeof validateDependencySchema>;
