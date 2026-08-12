import { Injectable } from '@nestjs/common';
import {
  canTransitionDependency,
  dependencyFingerprint,
  isDependencySatisfied,
  isTooVague,
  nextDependencyKey,
  secretsInDependency,
  summariseDependencies,
  type ClientDependency,
  type ClientDependencyCategory,
  type DependencyPriority,
  type DependencySourceKind,
  type DependencySummary,
  type Milestone,
  type RequirementItem,
  type ValidationFinding,
  type WorkPackage,
} from '@wdrg/contracts';

import {
  requirementReference,
  type ComposedContent,
  type ComposedRow,
  type DocumentComposer,
  type UpstreamContext,
  type ValidationInput,
} from './composer.types';

/**
 * Client Dependency Sheet — Document 7.
 *
 * ## What we need from you, and by when
 *
 * The last document, and the only one whose primary audience has to *act*. Everything
 * before it describes what will be built; this one lists what the project cannot
 * proceed without, who owns each item, and what happens if it is late.
 *
 * ## Every row is grounded in something already approved
 *
 * Five sources, and each is a decision somebody already made: an integration named in
 * the approved requirements, a third-party technology in the locked stack, a task in
 * the work breakdown that cannot start, a confirmed assumption about what the client
 * will provide, and a clarification nobody has answered.
 *
 * That last one matters more than it looks. An unanswered question *is* a dependency
 * on the client, and a project that leaves it off this sheet waits quietly for an
 * answer nobody knows is outstanding.
 *
 * What this composer will not do is write "client to provide all required
 * information". `isTooVague` refuses that wording, because a row nobody can action
 * and nobody can close makes the whole sheet ignorable.
 *
 * ## Dates are derived from the plan, and owners are left blank
 *
 * A due date comes from the working day of the earliest task that waits for the item,
 * expressed relative to commencement unless the approved plan has real dates. An owner
 * is left empty rather than guessed: naming the wrong person in a client-facing sheet
 * is worse than naming nobody, and a person filling it in is one click.
 *
 * ## Credentials are recorded, never carried
 *
 * A row may say sandbox credentials are needed, requested, received and checked. It
 * never holds the value. `secretsInDependency` rejects text that looks like one, on
 * every write path — because this sheet is exported and emailed, and a version is
 * immutable once issued.
 */
@Injectable()
export class ClientDependencyComposer implements DocumentComposer {
  readonly type = 'CLIENT_DEPENDENCY_SHEET' as const;
  readonly shape = 'ROWS' as const;
  readonly requiredSectionKeys = [];
  readonly rowKind = 'CLIENT_DEPENDENCY' as const;

  compose(context: UpstreamContext): ComposedContent {
    const packages = context.documents.workBreakdown?.packages ?? [];
    const requirements = new Map(
      context.requirements.map((requirement) => [requirement.key, requirement]),
    );

    const drafts: ClientDependency[] = [];
    const keys: string[] = [];

    const add = (
      draft: Omit<ClientDependency, 'dependencyKey'> & { readonly dependencyKey?: string },
    ): void => {
      /* A request asked for twice is one dependency with two features attached. */
      const fingerprint = dependencyFingerprint(draft);
      const existing = drafts.find((candidate) => dependencyFingerprint(candidate) === fingerprint);

      if (existing) {
        const merged: ClientDependency = {
          ...existing,
          requirementIds: [...new Set([...existing.requirementIds, ...draft.requirementIds])],
          featureIds: [...new Set([...existing.featureIds, ...draft.featureIds])],
          wbsIds: [...new Set([...existing.wbsIds, ...draft.wbsIds])],
          technologyIds: [...new Set([...existing.technologyIds, ...draft.technologyIds])],
          sourceKinds: [...new Set([...existing.sourceKinds, ...draft.sourceKinds])],
          /* The strictest claim wins: two callers, and one says this blocks a release. */
          priority: this.strongerPriority(existing.priority, draft.priority),
        };

        drafts.splice(drafts.indexOf(existing), 1, merged);

        return;
      }

      /* Nothing vague reaches the sheet, whatever produced it. */
      if (isTooVague(draft.dependency)) {
        return;
      }

      const dependencyKey = nextDependencyKey(keys);

      keys.push(dependencyKey);
      drafts.push({ ...draft, dependencyKey });
    };

    /* ------------------------------------------- 1. integrations, from the baseline */

    for (const requirement of context.requirements) {
      if (requirement.category !== 'integration') {
        continue;
      }

      const waiting = this.packagesFor(packages, [requirement.key]);
      const system = this.systemNameFrom(requirement);

      add({
        category: 'API_DOCUMENTATION',
        module: waiting[0]?.module ?? '',
        feature: waiting[0]?.feature ?? requirement.title,
        dependency: `API documentation and test access for ${system}`,
        description: `${requirement.statement.trim()} Building this exchange needs the interface documentation and an environment to test against.`,
        purpose: 'The integration cannot be built or verified without the interface it talks to.',
        sourceKinds: ['REQUIREMENT_BASELINE', ...(waiting.length > 0 ? ['WBS_TASK' as const] : [])],
        requirementIds: [requirement.key],
        featureIds: [],
        wbsIds: waiting.map((row) => row.wbsId),
        technologyIds: [],
        clientOwner: '',
        internalOwner: '',
        ...this.timingFor(waiting, context),
        priority: 'HIGH',
        blocking: waiting.length > 0 ? 'FEATURE' : 'TASK',
        impactIfDelayed: `Work on ${waiting[0]?.feature ?? requirement.title} cannot start, and anything sequenced after it moves by the same amount.`,
        expectedFormat: 'Interface documentation, plus credentials for a test environment',
        status: 'NOT_REQUESTED',
        validationNote: '',
        /* Access to a third-party system nearly always means credentials. */
        credentialsRequired: true,
        remarks: '',
      });
    }

    /* --------------------------------- 2. third-party technologies, from the stack */

    for (const component of context.stack?.components ?? []) {
      if (!this.needsClientAccount(component.category, component.technologyName)) {
        continue;
      }

      const waiting = packages.filter(
        (row) =>
          component.technologyId !== undefined &&
          row.technologyIds.includes(component.technologyId),
      );

      add({
        category: 'CREDENTIALS',
        module: waiting[0]?.module ?? '',
        feature: waiting[0]?.feature ?? '',
        dependency: `Account and credentials for ${component.technologyName}`,
        description: `${component.technologyName} is part of the approved technology stack for this project. The work needs an account you control, with credentials for a test environment and for production.`,
        purpose: `${component.technologyName} is in the locked technology stack, so the build depends on access to it.`,
        sourceKinds: ['TECHNOLOGY_STACK', ...(waiting.length > 0 ? ['WBS_TASK' as const] : [])],
        requirementIds: [],
        featureIds: [],
        wbsIds: waiting.map((row) => row.wbsId),
        technologyIds: component.technologyId ? [component.technologyId] : [],
        clientOwner: '',
        internalOwner: '',
        ...this.timingFor(waiting, context),
        priority: 'HIGH',
        blocking: waiting.length > 0 ? 'FEATURE' : 'TASK',
        impactIfDelayed:
          'The work that uses this service cannot be built or tested until access exists.',
        expectedFormat:
          'Account access, and credentials delivered through your own secret manager rather than by email',
        status: 'NOT_REQUESTED',
        validationNote: '',
        credentialsRequired: true,
        remarks: '',
      });
    }

    /* ------------------------------- 3. what the approved assumptions said you would do */

    for (const assumption of context.documents.assumptions?.assumptions ?? []) {
      const category = this.categoryForAssumption(assumption.statement);

      if (!category) {
        continue;
      }

      const waiting = this.packagesFor(packages, assumption.requirementIds);

      add({
        category,
        module: waiting[0]?.module ?? '',
        feature: waiting[0]?.feature ?? '',
        dependency: this.requestFromAssumption(assumption.statement, category),
        description: `The plan was built on this: "${assumption.statement.trim()}"`,
        purpose:
          'This was recorded as an assumption and agreed. The sheet makes it something specific to hand over.',
        sourceKinds: ['APPROVED_ASSUMPTION', ...(waiting.length > 0 ? ['WBS_TASK' as const] : [])],
        requirementIds: [...assumption.requirementIds],
        featureIds: [],
        wbsIds: waiting.map((row) => row.wbsId),
        technologyIds: [],
        clientOwner: '',
        internalOwner: '',
        ...this.timingFor(waiting, context),
        priority: 'MEDIUM',
        blocking: waiting.length > 0 ? 'TASK' : 'NONE',
        impactIfDelayed:
          'If this turns out not to hold, the estimate and the plan built on it both change.',
        expectedFormat: '',
        status: 'NOT_REQUESTED',
        validationNote: '',
        credentialsRequired: category === 'CREDENTIALS' || category === 'ACCESS',
        remarks: '',
      });
    }

    /* ------------------------------------ 4. questions nobody has answered */

    for (const clarification of context.openClarifications) {
      const waiting = this.packagesFor(packages, clarification.requirementIds);

      add({
        category: 'BUSINESS_DECISION',
        module: waiting[0]?.module ?? '',
        feature: waiting[0]?.feature ?? '',
        dependency: `An answer to: ${this.shorten(clarification.question, 240)}`,
        description: clarification.question,
        purpose:
          'This question was raised during analysis and has not been answered. The work it affects cannot be finished on a guess.',
        sourceKinds: ['OPEN_CLARIFICATION'],
        requirementIds: [...clarification.requirementIds],
        featureIds: [],
        wbsIds: waiting.map((row) => row.wbsId),
        technologyIds: [],
        clientOwner: '',
        internalOwner: '',
        ...this.timingFor(waiting, context),
        priority: clarification.blocking ? 'CRITICAL' : 'MEDIUM',
        blocking: clarification.blocking ? 'FEATURE' : 'TASK',
        impactIfDelayed: clarification.blocking
          ? 'This was recorded as blocking during analysis: the affected work cannot be completed until it is answered.'
          : 'The affected work may have to be revisited once this is answered.',
        expectedFormat: 'A decision, from somebody able to make it',
        status: 'NOT_REQUESTED',
        validationNote: '',
        credentialsRequired: false,
        remarks: '',
      });
    }

    /* --------------------------------- 5. review, UAT and approval gates in the plan */

    for (const milestone of context.plan?.milestones ?? []) {
      const category = this.categoryForMilestone(milestone.kind);

      if (!category) {
        continue;
      }

      const waiting = packages.filter((row) => row.milestoneId === milestone.id);

      add({
        category,
        module: '',
        feature: '',
        dependency:
          category === 'UAT'
            ? 'People available to run user acceptance testing'
            : `Sign-off at ${milestone.label.toLowerCase()}`,
        description:
          category === 'UAT'
            ? 'The approved plan includes user acceptance testing, which needs your people for the days it runs.'
            : `The approved plan reaches ${milestone.label.toLowerCase()} at this point and waits for your approval before continuing.`,
        purpose: 'The approved schedule allows time for this, and the plan assumes it happens.',
        sourceKinds: ['WBS_TASK'],
        requirementIds: [],
        featureIds: [],
        wbsIds: waiting.map((row) => row.wbsId),
        technologyIds: [],
        clientOwner: '',
        internalOwner: '',
        relativeDue: `by working day ${milestone.day}`,
        ...(context.plan && !context.plan.relativeOnly && milestone.date
          ? { actualDueDate: milestone.date }
          : {}),
        requiredForMilestoneId: milestone.id,
        priority: 'MEDIUM',
        blocking: category === 'UAT' ? 'UAT' : 'MILESTONE',
        impactIfDelayed:
          'Everything after this point in the schedule moves by however long it takes.',
        expectedFormat: '',
        status: 'NOT_REQUESTED',
        validationNote: '',
        credentialsRequired: false,
        remarks: '',
      });
    }

    return {
      sections: [],
      features: [],
      rows: drafts.map((dependency, index): ComposedRow => ({
        order: index,
        references: [
          ...dependency.requirementIds
            .map((key) => requirements.get(key))
            .filter((requirement): requirement is RequirementItem => requirement !== undefined)
            .map(requirementReference),
          ...dependency.technologyIds.map((id) => ({ kind: 'TECHNOLOGY_COMPONENT' as const, id })),
        ],
        payload: { ...dependency },
      })),
    };
  }

  /* ------------------------------------------------------------ helpers */

  /** Work packages that wait on any of these requirements. */
  private packagesFor(
    packages: readonly WorkPackage[],
    requirementIds: readonly string[],
  ): readonly WorkPackage[] {
    const wanted = new Set(requirementIds);

    return packages.filter(
      (row) =>
        row.level === 'TASK' &&
        row.status !== 'EXCLUDED' &&
        row.requirementIds.some((key) => wanted.has(key)),
    );
  }

  /**
   * When this is needed, from the plan rather than from a guess.
   *
   * The earliest task that waits for it sets the deadline. Relative to commencement
   * unless the approved plan has real dates — a date on a project with no agreed start
   * would be this document inventing the thing the estimate left open, and a client
   * reads a date as a promise.
   */
  private timingFor(
    waiting: readonly WorkPackage[],
    context: UpstreamContext,
  ): Pick<ClientDependency, 'relativeDue' | 'actualDueDate' | 'requiredForMilestoneId'> {
    const earliest = [...waiting]
      .filter((row) => row.relativeStartDay !== undefined)
      .sort((first, second) => first.relativeStartDay! - second.relativeStartDay!)[0];

    if (!earliest) {
      return { relativeDue: 'before the work that needs it starts' };
    }

    const dated = context.plan !== null && !context.plan.relativeOnly;

    return {
      relativeDue:
        earliest.relativeStartDay === 1
          ? 'before work starts'
          : `before working day ${earliest.relativeStartDay}, when "${earliest.task}" is due to start`,
      ...(dated && earliest.actualStartDate ? { actualDueDate: earliest.actualStartDate } : {}),
      ...(earliest.milestoneId ? { requiredForMilestoneId: earliest.milestoneId } : {}),
    };
  }

  /**
   * Whether a stack component needs an account only the client can open.
   *
   * Read from the component's category and name. Infrastructure a delivery team
   * provisions is not a client dependency, and listing it would pad the sheet with
   * items the client cannot act on — which is how a real dependency gets missed among
   * fifteen fake ones.
   */
  private needsClientAccount(category: string, name: string): boolean {
    const external =
      /^(payment|sms|email|notification|analytics|maps|storage|search|auth|integration|third_party|ai|ml)/i.test(
        category,
      );

    const named =
      /\b(stripe|razorpay|paypal|twilio|sendgrid|mailgun|firebase|auth0|okta|google|aws|azure|salesforce|zoho|hubspot|xero|quickbooks|tally)\b/i.test(
        name,
      );

    return external || named;
  }

  /**
   * What an assumption is really asking the client for, if anything.
   *
   * Conservative on purpose. Most assumptions are about how the system behaves and
   * are nobody's action item; only the ones that clearly describe the client
   * providing something become rows. A false row here is a request the client cannot
   * satisfy and will ignore.
   */
  private categoryForAssumption(statement: string): ClientDependencyCategory | null {
    const text = statement.toLowerCase();

    if (!/\b(client|customer|you|your|they)\b/.test(text)) {
      return null;
    }

    if (/\b(credential|api key|token|account|access|login)\b/.test(text)) {
      return 'CREDENTIALS';
    }

    if (/\b(content|copy|text|catalogue|catalog|product data|image|photo|logo)\b/.test(text)) {
      return 'CONTENT';
    }

    if (/\b(design|wireframe|mockup|brand|style guide)\b/.test(text)) {
      return 'DESIGN_ASSET';
    }

    if (/\b(data|export|migration|spreadsheet|csv|records)\b/.test(text)) {
      return 'DATA';
    }

    if (/\b(server|hosting|domain|infrastructure|environment)\b/.test(text)) {
      return 'INFRASTRUCTURE';
    }

    if (/\b(approve|approval|sign[- ]off|review)\b/.test(text)) {
      return 'APPROVAL';
    }

    return null;
  }

  /** A specific request, built from what the assumption said. */
  private requestFromAssumption(statement: string, category: ClientDependencyCategory): string {
    const noun: Partial<Record<ClientDependencyCategory, string>> = {
      CREDENTIALS: 'Credentials and account access',
      CONTENT: 'Content',
      DESIGN_ASSET: 'Design assets',
      DATA: 'Data export',
      INFRASTRUCTURE: 'Infrastructure and hosting',
      APPROVAL: 'Approval',
    };

    return `${noun[category] ?? 'Input'} as assumed: ${this.shorten(statement, 200)}`;
  }

  /** Milestones that are a client gate rather than an internal one. */
  private categoryForMilestone(kind: Milestone['kind']): ClientDependencyCategory | null {
    if (kind === 'uat') {
      return 'UAT';
    }

    if (kind === 'release_readiness' || kind === 'production_deployment') {
      return 'APPROVAL';
    }

    return null;
  }

  private strongerPriority(
    first: DependencyPriority,
    second: DependencyPriority,
  ): DependencyPriority {
    const order: readonly DependencyPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

    return order.indexOf(first) >= order.indexOf(second) ? first : second;
  }

  private systemNameFrom(requirement: RequirementItem): string {
    /*
     * The proper noun the requirement itself names. Falling back to its title rather
     * than to "the third-party system", so the row names something the client
     * recognises and can go and find.
     */
    const match = /\b([A-Z][A-Za-z0-9]*(?: [A-Z][A-Za-z0-9]*)?)\b/.exec(requirement.statement);

    return match?.[1] ?? requirement.title;
  }

  private shorten(text: string, length: number): string {
    const trimmed = text.trim().replace(/\s+/g, ' ');

    return trimmed.length <= length ? trimmed : `${trimmed.slice(0, length - 1)}…`;
  }

  /* --------------------------------------------------------- validation */

  validate(input: ValidationInput): readonly ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    const rows = input.rows.filter((row) => row.excludedReason === undefined);
    const dependencies = rows.map((row) => row.payload as ClientDependency);
    const packages = input.context.documents.workBreakdown?.packages ?? [];

    /*
     * 1. Secrets. First, and BLOCKING without exception. An issued version is
     * immutable and gets exported and emailed, so a credential that reaches this
     * document is a credential that cannot be recalled.
     */
    const leaking = dependencies
      .map((dependency) => ({ dependency, secrets: secretsInDependency(dependency) }))
      .filter((entry) => entry.secrets.length > 0);

    if (leaking.length > 0) {
      findings.push({
        kind: 'credential_value_present',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${leaking.length} row appears to contain an actual credential rather than a description of one.`,
        action:
          'Record that the credential is needed, not its value. Anything issued in this document cannot be taken back.',
        subjectIds: leaking.map((entry) => entry.dependency.dependencyKey),
      });
    } else {
      findings.push({
        kind: 'credential_value_present',
        severity: 'PASS',
        detectedBy: 'DETERMINISTIC',
        summary: 'No row carries a credential value.',
        action: `${dependencies.filter((dependency) => dependency.credentialsRequired).length} row records that credentials are required, without holding one.`,
        subjectIds: [],
      });
    }

    /* 2. Rows nobody can action or close. */
    const vague = dependencies.filter((dependency) => isTooVague(dependency.dependency));

    if (vague.length > 0) {
      findings.push({
        kind: 'dependency_vague',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${vague.length} row is too vague for anybody to act on or close.`,
        action: vague
          .map((dependency) => `${dependency.dependencyKey}: "${dependency.dependency}"`)
          .join('; '),
        subjectIds: vague.map((dependency) => dependency.dependencyKey),
      });
    }

    /* 3. Rows that trace to nothing approved. */
    const ungrounded = dependencies.filter(
      (dependency, index) =>
        dependency.sourceKinds.length === 0 ||
        (dependency.requirementIds.length === 0 &&
          dependency.wbsIds.length === 0 &&
          dependency.technologyIds.length === 0 &&
          !this.selfEvidentSource(dependency.sourceKinds) &&
          rows[index]?.origin !== 'USER_DEFINED'),
    );

    if (ungrounded.length > 0) {
      findings.push({
        kind: 'dependency_ungrounded',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${ungrounded.length} row traces to no approved requirement, technology or task.`,
        action:
          'Every request has to rest on something the client agreed to, or it is one they can argue with.',
        subjectIds: ungrounded.map((dependency) => dependency.dependencyKey),
      });
    }

    /* 4. Citations that name something outside the approved baseline. */
    const approved = new Set(input.context.requirements.map((requirement) => requirement.key));
    const unknown = [
      ...new Set(
        dependencies.flatMap((dependency) =>
          dependency.requirementIds.filter((key) => !approved.has(key)),
        ),
      ),
    ];

    if (unknown.length > 0) {
      findings.push({
        kind: 'unknown_requirement',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unknown.length} row cites a requirement that is not in the approved baseline.`,
        action: unknown.join(', '),
        subjectIds: unknown,
      });
    }

    /* 5. Rows pointing at work packages the breakdown does not contain. */
    const wbsIds = new Set(packages.map((row) => row.wbsId));
    const danglingWbs = dependencies.filter((dependency) =>
      dependency.wbsIds.some((id) => !wbsIds.has(id)),
    );

    if (danglingWbs.length > 0 && packages.length > 0) {
      findings.push({
        kind: 'dependency_unlinked',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${danglingWbs.length} row points at a task that is not in the current work breakdown.`,
        action: 'Regenerate this sheet against the current breakdown.',
        subjectIds: danglingWbs.map((dependency) => dependency.dependencyKey),
      });
    }

    /*
     * 6. A blocking row that nothing waits for. Not fatal — a genuine dependency can
     * precede any single task — but a blocking claim with no work behind it is
     * usually a leftover, and it is what makes a sheet feel like a formality.
     */
    const unlinked = dependencies.filter(
      (dependency) =>
        dependency.blocking !== 'NONE' &&
        dependency.wbsIds.length === 0 &&
        dependency.requiredForMilestoneId === undefined,
    );

    if (unlinked.length > 0) {
      findings.push({
        kind: 'dependency_unlinked',
        severity: 'WARNING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unlinked.length} row says it blocks work without naming what it blocks.`,
        action: 'Link each to the task or milestone that waits for it, or lower what it claims.',
        subjectIds: unlinked.map((dependency) => dependency.dependencyKey),
      });
    }

    /*
     * 7. Blocking work with nothing asked for on its behalf.
     *
     * The sheet owns the relationship, so "a task waiting on a dependency that is not
     * here" cannot be read off the work package — that would need a field on the WBS
     * which generating this document would have to write, and that is the cycle this
     * design avoids. What can be checked is the other direction: a critical-path task in
     * a module where dependencies were raised, with none of its own. A heuristic rather
     * than a fact, so it warns rather than blocks.
     */
    const linkedModules = new Set(
      dependencies.flatMap((dependency) => (dependency.module ? [dependency.module] : [])),
    );
    const covered = new Set(dependencies.flatMap((dependency) => dependency.wbsIds));

    const criticalUncovered = packages.filter(
      (row) =>
        row.level === 'TASK' &&
        row.status !== 'EXCLUDED' &&
        row.workKind === 'FEATURE' &&
        row.onCriticalPath &&
        linkedModules.has(row.module) &&
        !covered.has(row.wbsId),
    );

    if (criticalUncovered.length > 0) {
      findings.push({
        kind: 'dependency_missing_for_task',
        severity: 'WARNING',
        detectedBy: 'DETERMINISTIC',
        summary: `${criticalUncovered.length} task on the critical path sits in a module with client dependencies and has none of its own.`,
        action:
          'Worth a look: either it genuinely needs nothing from the client, or a request is missing.',
        subjectIds: criticalUncovered.map((row) => row.wbsId),
      });
    }

    /* 8. States that cannot have been reached, and checks nobody recorded. */
    const impossible = dependencies.filter(
      (dependency) =>
        (dependency.status === 'ACCEPTED' || dependency.status === 'REJECTED') &&
        dependency.validationNote.trim().length === 0,
    );

    if (impossible.length > 0) {
      findings.push({
        kind: 'dependency_status_invalid',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${impossible.length} row is accepted or rejected with nothing recorded about the check.`,
        action:
          'Received is not accepted. Say what was checked and what it showed, so the decision is auditable.',
        subjectIds: impossible.map((dependency) => dependency.dependencyKey),
      });
    }

    const receivedWithoutTimestamp = dependencies.filter(
      (dependency) =>
        (dependency.status === 'RECEIVED' ||
          dependency.status === 'PARTIALLY_RECEIVED' ||
          dependency.status === 'ACCEPTED') &&
        dependency.receivedAt === undefined,
    );

    if (receivedWithoutTimestamp.length > 0) {
      findings.push({
        kind: 'dependency_detail_invented',
        severity: 'WARNING',
        detectedBy: 'DETERMINISTIC',
        summary: `${receivedWithoutTimestamp.length} row is marked as received with no record of when.`,
        action:
          'The sheet is the record of what arrived and when. Set it through the status action.',
        subjectIds: receivedWithoutTimestamp.map((dependency) => dependency.dependencyKey),
      });
    }

    /* 9. Duplicated requests. */
    const byFingerprint = new Map<string, string[]>();

    for (const dependency of dependencies) {
      const fingerprint = dependencyFingerprint(dependency);

      byFingerprint.set(fingerprint, [
        ...(byFingerprint.get(fingerprint) ?? []),
        dependency.dependencyKey,
      ]);
    }

    const duplicates = [...byFingerprint.values()].filter((keys) => keys.length > 1);

    if (duplicates.length > 0) {
      findings.push({
        kind: 'duplicate_content',
        severity: 'WARNING',
        detectedBy: 'DETERMINISTIC',
        summary: `${duplicates.length} request appears more than once.`,
        action: `${duplicates.map((keys) => keys.join(' and ')).join('; ')}. A duplicated request gets chased twice.`,
        subjectIds: duplicates.flat(),
      });
    }

    /* 10. Rows a person added with nothing recorded about where they came from. */
    const unattributed = rows
      .filter(
        (row) =>
          row.origin === 'USER_DEFINED' &&
          row.references.length === 0 &&
          (row.attribution ?? '').trim().length === 0,
      )
      .map((row) => (row.payload as ClientDependency).dependencyKey);

    if (unattributed.length > 0) {
      findings.push({
        kind: 'attribution_missing',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unattributed.length} row was added by hand with nothing recorded about where it came from.`,
        action:
          'Say what each one rests on — a request nobody can trace is one a client can refuse.',
        subjectIds: unattributed,
      });
    }

    /* 11. What is still outstanding, as a statement of fact rather than a fault. */
    const outstanding = dependencies.filter(
      (dependency) => !isDependencySatisfied(dependency.status),
    );
    const blocking = outstanding.filter((dependency) => dependency.blocking !== 'NONE');

    findings.push({
      kind: 'requirement_uncovered',
      severity: 'PASS',
      detectedBy: 'DETERMINISTIC',
      summary:
        blocking.length === 0
          ? 'Nothing outstanding on this sheet is blocking work.'
          : `${blocking.length} of ${dependencies.length} items are outstanding and block work.`,
      action: blocking.map((dependency) => dependency.dependencyKey).join(', '),
      subjectIds: blocking.map((dependency) => dependency.dependencyKey),
    });

    /* 12. The upstream authority this document quotes. */
    if (!input.baselineCurrent) {
      findings.push({
        kind: 'stale_baseline',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: 'The approved requirements have changed since this sheet was written.',
        action: 'Regenerate against the current baseline.',
        subjectIds: [],
      });
    }

    return findings;
  }

  /**
   * Sources that are their own evidence.
   *
   * An unanswered clarification and a stated request from a person are grounded by
   * existing — there is no requirement to point at, and demanding one would push
   * somebody into citing an unrelated requirement to satisfy a check.
   */
  private selfEvidentSource(kinds: readonly DependencySourceKind[]): boolean {
    return kinds.includes('OPEN_CLARIFICATION') || kinds.includes('USER_STATED');
  }

  /**
   * What is outstanding, for the screen as well as the checker.
   *
   * The number somebody acts on. A sheet of forty rows where three block a milestone
   * is a different situation from one where thirty do, and reading forty rows to find
   * out is how the sheet stops being read.
   */
  summaryFor(input: ValidationInput): DependencySummary {
    return summariseDependencies(
      input.rows
        .filter((row) => row.excludedReason === undefined)
        .map((row) => row.payload as ClientDependency),
    );
  }

  /** Every requirement that names an external system is answerable for here. */
  applicableRequirementIds(context: UpstreamContext): readonly string[] {
    return context.requirements
      .filter((requirement) => requirement.category === 'integration')
      .map((requirement) => requirement.key);
  }

  /** Whether a status change a person asked for is one the lifecycle allows. */
  canTransition(from: ClientDependency['status'], to: ClientDependency['status']): boolean {
    return canTransitionDependency(from, to);
  }
}
