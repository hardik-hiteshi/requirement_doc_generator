import { Injectable } from '@nestjs/common';
import {
  criterionText,
  entersApprovedDocument,
  internalMethodologyTerms,
  inventedDates,
  isModelWritableSowSection,
  prohibitedLegalTerms,
  reconcileSowScope,
  staffingClaims,
  timelineStatement,
  unsupportedDeliverables,
  ASSUMPTION_CATEGORY_LABELS,
  OUTSTANDING_COMMERCIAL_TERMS,
  REQUIRED_SOW_SECTION_KEYS,
  SOW_SECTIONS,
  type AcceptanceCriterion,
  type Assumption,
  type DocumentReference,
  type ValidationFinding,
} from '@wdrg/contracts';

import {
  requirementReference,
  type ComposedContent,
  type ComposedSection,
  type DocumentComposer,
  type UpstreamContext,
  type ValidationInput,
} from './composer.types';

/**
 * Statement of Work — Document 5.
 *
 * ## Every section is a transcription
 *
 * Scope comes from the approved Feature Listing. Technology comes from the locked
 * stack, name for name. The timeline comes from the approved schedule, in the form
 * the schedule permits. Assumptions come from the approved Assumptions document, and
 * only the confirmed ones. Acceptance points at the approved Acceptance Criteria
 * rather than describing a second standard.
 *
 * Nothing here interprets. That is the whole design: a commercial document is the
 * place where an invented number becomes an obligation, so the composer's job is to
 * copy accurately and the validator's job is to prove it copied.
 *
 * ## What is left out on purpose
 *
 * The commercial and legal terms nobody supplied. `OUTSTANDING_COMMERCIAL_TERMS` is
 * written into the document as a list of what is *missing* — price, payment,
 * governing law, liability, IP — because a document that silently omits them reads
 * as complete, and one that invents them is worse. Saying "these have not been
 * provided" is the only honest option, and it is also the useful one: it tells the
 * person sending this what they still have to add.
 */
@Injectable()
export class StatementOfWorkComposer implements DocumentComposer {
  readonly type = 'STATEMENT_OF_WORK' as const;
  readonly shape = 'SECTIONS' as const;
  readonly requiredSectionKeys = REQUIRED_SOW_SECTION_KEYS;

  compose(context: UpstreamContext): ComposedContent {
    const sections: ComposedSection[] = SOW_SECTIONS.map((template) => {
      const { body, references, omittedReason } = this.sectionFor(template.key, context);

      return {
        key: template.key,
        title: template.title,
        order: template.order,
        body,
        references,
        ...(omittedReason ? { omittedReason } : {}),
      };
    });

    return { sections, features: [], rows: [] };
  }

  private sectionFor(
    key: string,
    context: UpstreamContext,
  ): {
    readonly body: string;
    readonly references: readonly DocumentReference[];
    readonly omittedReason?: string;
  } {
    const features = context.documents.featureListing?.features ?? [];
    const criteria = context.documents.acceptanceCriteria?.criteria ?? [];
    const assumptions = (context.documents.assumptions?.assumptions ?? []).filter(
      entersApprovedDocument,
    );
    const requirementReferences = context.requirements.slice(0, 40).map(requirementReference);

    const empty = (reason: string) => ({ body: '', references: [], omittedReason: reason });

    switch (key) {
      case 'project-overview': {
        const overview = this.understandingSection(context, 'project-overview');

        return overview
          ? { body: overview, references: requirementReferences }
          : {
              body: `${context.projectName} is described by ${context.requirements.length} approved requirement${context.requirements.length === 1 ? '' : 's'}.`,
              references: requirementReferences,
            };
      }

      case 'objective': {
        const objective = this.understandingSection(context, 'business-objective');

        return objective
          ? { body: objective, references: requirementReferences }
          : empty('The approved requirements do not state a business objective.');
      }

      case 'scope-of-work': {
        if (features.length === 0) {
          return empty('The approved Feature Listing has no rows.');
        }

        const modules = [...new Set(features.map((feature) => feature.module))].filter(Boolean);

        return {
          body: [
            `The work covers ${features.length} feature${features.length === 1 ? '' : 's'} across ${modules.length} area${modules.length === 1 ? '' : 's'} of the system: ${modules.join(', ')}.`,
            'Each feature is listed in the approved Feature Listing, which is the authoritative statement of what is included.',
          ].join('\n\n'),
          references: requirementReferences,
        };
      }

      case 'functional-scope': {
        if (features.length === 0) {
          return empty('The approved Feature Listing has no rows.');
        }

        /*
         * Every approved feature, named. This is what reconciliation checks
         * against, so it lists all of them rather than a readable selection: a
         * commercial document that summarises scope is one where something can go
         * missing without anybody noticing.
         */
        const byModule = new Map<string, string[]>();

        for (const feature of features) {
          const label = feature.module || 'General';
          byModule.set(label, [...(byModule.get(label) ?? []), feature.description]);
        }

        return {
          body: [...byModule.entries()]
            .map(([module, items]) => `${module}\n${items.map((item) => `- ${item}`).join('\n')}`)
            .join('\n\n'),
          references: requirementReferences,
        };
      }

      case 'deliverables': {
        if (features.length === 0) {
          return empty('There is no approved scope to deliver yet.');
        }

        const platforms = context.projectTypes.length > 0 ? context.projectTypes : ['application'];

        return {
          body: [
            ...platforms.map(
              (platform) =>
                `- The ${platform.replace(/_/g, ' ')} described in the approved Feature Listing, implemented and deployed to the agreed environment.`,
            ),
            '- The approved Acceptance Criteria, satisfied and demonstrable.',
          ].join('\n'),
          references: requirementReferences,
        };
      }

      case 'out-of-scope': {
        const excluded = context.documents.featureListing?.excludedRequirementIds ?? [];
        const stated = this.understandingSection(context, 'out-of-scope');

        if (!stated && excluded.length === 0) {
          return empty('Nothing has been recorded as explicitly out of scope.');
        }

        return {
          body: [
            stated,
            excluded.length > 0
              ? `The following approved requirements were deliberately excluded from the Feature Listing: ${excluded.join(', ')}.`
              : '',
          ]
            .filter(Boolean)
            .join('\n\n'),
          references: [],
        };
      }

      /*
       * The four sections below are pure transcription, and no model may rewrite
       * them — `MODEL_WRITABLE_SOW_SECTIONS` excludes each one. Rewording a
       * technology name or a duration is how a document stops matching what was
       * approved.
       */
      case 'technology': {
        if (!context.stack) {
          return empty('No technology stack has been locked for this project.');
        }

        const byCategory = new Map<string, string[]>();

        for (const component of context.stack.components) {
          byCategory.set(component.category, [
            ...(byCategory.get(component.category) ?? []),
            component.technologyName,
          ]);
        }

        return {
          body: [
            'The following technologies are agreed for this implementation:',
            ...[...byCategory.entries()].map(
              ([category, names]) => `- ${category.replace(/_/g, ' ')}: ${names.join(', ')}`,
            ),
          ].join('\n'),
          references: context.stack.components
            .filter((component) => component.technologyId)
            .map((component) => ({
              kind: 'TECHNOLOGY_COMPONENT' as const,
              id: component.technologyId!,
              label: component.technologyName,
            })),
        };
      }

      case 'timeline': {
        if (!context.timeline) {
          return empty('No estimate has been approved, so there is no agreed timeline.');
        }

        const statement = timelineStatement(context.timeline);

        return {
          body: context.timeline.acknowledgedRisk
            ? `${statement}\n\nThis timeline was accepted in the knowledge that it carries delivery risk. Meeting it depends on the dependencies and assumptions set out in this document being met.`
            : statement,
          references: context.estimate
            ? [{ kind: 'ESTIMATE_UNIT', id: context.estimate.id, label: 'The approved estimate' }]
            : [],
        };
      }

      case 'milestones': {
        if (!context.timeline || context.estimateUnits.length === 0) {
          return empty('No approved estimate, so there is no milestone structure to state.');
        }

        /*
         * A summary of the approved schedule's shape, not a plan of its own. The
         * detailed work breakdown is Document 6, and producing one here would mean
         * two plans that can disagree.
         */
        const modules = [...new Set(features.map((feature) => feature.module))].filter(Boolean);

        return {
          body: [
            'Delivery is structured around the approved estimate:',
            ...modules.map((module, index) => `- Stage ${index + 1}: ${module}`),
            'A detailed work breakdown is produced separately and is not part of this document.',
          ].join('\n'),
          references: [],
        };
      }

      case 'assumptions': {
        if (assumptions.length === 0) {
          return empty(
            'No assumptions have been confirmed for this project. Anything not confirmed as an assumption is not treated as one.',
          );
        }

        const byCategory = new Map<string, string[]>();

        for (const assumption of assumptions) {
          const label = ASSUMPTION_CATEGORY_LABELS[assumption.category];
          byCategory.set(label, [...(byCategory.get(label) ?? []), assumption.statement]);
        }

        return {
          body: [
            'This statement of work rests on the following confirmed assumptions:',
            ...[...byCategory.entries()].map(
              ([category, statements]) =>
                `${category}\n${statements.map((statement) => `- ${statement}`).join('\n')}`,
            ),
          ].join('\n\n'),
          references: [],
        };
      }

      case 'acceptance': {
        if (criteria.length === 0) {
          return empty('No Acceptance Criteria document has been approved yet.');
        }

        return {
          body: [
            `Acceptance is measured against the approved Acceptance Criteria, which sets out ${criteria.length} condition${criteria.length === 1 ? '' : 's'} covering the agreed scope.`,
            'Work is accepted when those conditions are demonstrated. This document does not define a separate acceptance standard.',
          ].join('\n\n'),
          references: [],
        };
      }

      case 'roles': {
        /* Every role the approved estimate priced, and no other. */
        const roles = [
          ...new Set(context.estimateUnits.flatMap((unit) => Object.keys(unit.effort))),
        ];

        if (roles.length === 0) {
          return empty('No approved estimate, so the roles involved are not yet established.');
        }

        /*
         * Responsibilities, never headcount. "Two developers will be assigned" is a
         * staffing promise nobody made; naming what a role is responsible for
         * claims nothing about who does it or how many of them there are.
         */
        return {
          body: [
            'The following responsibilities apply to this engagement:',
            ...roles.map((role) => `- ${this.roleLabel(role)}`),
            '- Client: the approvals, access and information set out under dependencies.',
          ].join('\n'),
          references: [],
        };
      }

      case 'change-management': {
        return {
          body: [
            'The approved scope recorded in the Feature Listing and Acceptance Criteria is the baseline for this engagement.',
            'A request outside that baseline is assessed for its effect on scope, effort and timeline before it is taken on. Where a change is accepted, the requirements, estimate and these documents are updated and re-approved, so there is one agreed version of what is being built.',
            'No change takes effect on the basis of this document alone.',
          ].join('\n\n'),
          references: [],
        };
      }

      case 'client-dependencies': {
        /*
         * High level only, and only what the evidence supports. The detailed
         * dependency sheet — owners, dates, tracking — is Document 7.
         */
        const grounded: string[] = [];

        if (context.clarifications.some((clarification) => !clarification.confirmed)) {
          grounded.push('- Answers to the outstanding requirement clarifications.');
        }

        if (assumptions.some((assumption) => assumption.category === 'CLIENT')) {
          grounded.push('- The items recorded as client assumptions in this document.');
        }

        if (
          context.requirements.some((requirement) =>
            /\b(integrat|api|third[- ]party|export|import)\b/i.test(
              `${requirement.title} ${requirement.statement}`,
            ),
          )
        ) {
          grounded.push(
            '- Access and documentation for the systems this work has to exchange data with.',
          );
        }

        grounded.push('- Timely review and approval of the documents in this set.');

        return { body: grounded.join('\n'), references: [] };
      }

      case 'constraints': {
        const constraints = context.requirements.filter(
          (requirement) => requirement.category === 'constraint',
        );

        if (constraints.length === 0) {
          return empty('No constraints were recorded in the approved requirements.');
        }

        return {
          body: constraints.map((requirement) => `- ${requirement.statement}`).join('\n'),
          references: constraints.map(requirementReference),
        };
      }

      case 'approach': {
        const understanding = this.understandingSection(context, 'core-workflows');

        return understanding
          ? { body: understanding, references: [] }
          : empty('No implementation approach has been recorded.');
      }

      case 'commercial-terms': {
        /*
         * Stated as outstanding. This application has no price, no payment terms and
         * no legal instructions, and writing plausible ones would be the single most
         * damaging thing it could do.
         */
        return {
          body: [
            'The following have not been provided and are not covered by this document:',
            ...OUTSTANDING_COMMERCIAL_TERMS.map((term) => `- ${term}`),
            'They must be agreed separately before this becomes a contract.',
          ].join('\n'),
          references: [],
        };
      }

      case 'sign-off': {
        return {
          body: 'This statement of work is issued for review and agreement by both parties.',
          references: [],
        };
      }

      default:
        return empty('Nothing recorded for this section.');
    }
  }

  /** A section of the approved Our Understanding, when it is authority. */
  private understandingSection(context: UpstreamContext, key: string): string {
    const section = context.documents.understanding?.sections.find(
      (candidate) => candidate.key === key,
    );

    return (section?.body ?? '').trim();
  }

  private roleLabel(role: string): string {
    const labels: Readonly<Record<string, string>> = {
      BACKEND: 'Backend engineering — server-side business logic and APIs',
      FRONTEND: 'Frontend engineering — the user interface described in the scope',
      MOBILE: 'Mobile engineering — the mobile application described in the scope',
      QA: 'Quality assurance — verifying the agreed acceptance criteria',
      DESIGN: 'Design — the interface and interaction design for the agreed screens',
      DEVOPS: 'Infrastructure — environments, deployment and release',
      PM: 'Delivery management — planning, reporting and coordination',
      BA: 'Business analysis — requirements and acceptance detail',
    };

    return labels[role] ?? `${role}: as described in the approved estimate`;
  }

  /* --------------------------------------------------------- validation */

  validate(input: ValidationInput): readonly ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    const context = input.context;
    const bodyOf = (key: string): string =>
      input.sections.find((section) => section.key === key)?.body ?? '';
    const everything = input.sections.map((section) => section.body).join('\n\n');

    /* 1. Scope reconciles with the approved Feature Listing, both ways. */
    const reconciliation = this.reconciliationFor(input);

    findings.push(
      reconciliation.reconciled
        ? {
            kind: 'scope_not_reconciled',
            severity: 'PASS',
            detectedBy: 'DETERMINISTIC',
            summary: `The scope stated here is exactly the ${reconciliation.approvedFeatures} approved features, with nothing added and nothing missing.`,
            action: '',
            subjectIds: [],
          }
        : {
            kind: 'scope_not_reconciled',
            severity: 'BLOCKING',
            detectedBy: 'DETERMINISTIC',
            summary:
              reconciliation.contradictedExclusions.length > 0
                ? 'This document describes something as included that the approved scope excludes.'
                : `The scope stated here does not match the approved Feature Listing: ${reconciliation.missingFeatureIds.length} missing, ${reconciliation.unknownFeatureIds.length} not in the listing.`,
            action:
              'Regenerate the scope sections — a commercial document has to promise what was agreed and estimated.',
            subjectIds: [
              ...reconciliation.missingFeatureIds,
              ...reconciliation.unknownFeatureIds,
            ].slice(0, 200),
          },
    );

    /* 2. The technology is the locked stack, name for name. */
    const technology = bodyOf('technology');

    if (context.stack && technology.length > 0) {
      const locked = context.stack.components.map((component) => component.technologyName);
      const missing = locked.filter((name) => !technology.includes(name));

      if (missing.length > 0) {
        findings.push({
          kind: 'stack_mismatch',
          severity: 'BLOCKING',
          detectedBy: 'DETERMINISTIC',
          summary: `${missing.length} locked technology is missing from the technology section.`,
          action: `Regenerate it — the stack is ${locked.join(', ')}.`,
          subjectIds: [...missing],
        });
      }

      /*
       * A technology that is *not* in the locked stack, named as though it were.
       * Checked against the catalogue's vocabulary of alternatives rather than
       * against every word, so an ordinary sentence does not trip it.
       */
      const intruders = this.namedTechnologiesOutsideStack(technology, locked);

      if (intruders.length > 0) {
        findings.push({
          kind: 'unknown_technology_reference',
          severity: 'BLOCKING',
          detectedBy: 'DETERMINISTIC',
          summary: `The technology section names ${intruders.join(', ')}, which is not in the locked stack.`,
          action: 'Technologies come from the stack you locked. Unlock it if it needs to change.',
          subjectIds: [...intruders],
        });
      }
    }

    /* 3. The timeline is the approved one, and no date was invented. */
    const timelineBody = bodyOf('timeline');

    if (context.timeline && timelineBody.length > 0) {
      const invented = inventedDates(everything, context.timeline);

      if (invented.length > 0) {
        findings.push({
          kind: 'timeline_mismatch',
          severity: 'BLOCKING',
          detectedBy: 'DETERMINISTIC',
          summary: `This document names ${invented.length} date that the approved estimate does not: ${invented.join(', ')}.`,
          action:
            'The estimate is scheduled relative to an unconfirmed start, so no calendar date can be stated. Regenerate the timeline.',
          subjectIds: [...invented],
        });
      }

      const expected = timelineStatement(context.timeline);
      const duration = /approximately (\d+) working/.exec(expected)?.[1];

      if (duration && !timelineBody.includes(duration)) {
        findings.push({
          kind: 'timeline_mismatch',
          severity: 'BLOCKING',
          detectedBy: 'DETERMINISTIC',
          summary: `The timeline here does not state the approved duration of ${duration} working weeks.`,
          action:
            'Regenerate the timeline section — the duration comes from the approved estimate.',
          subjectIds: [],
        });
      }

      if (
        context.timeline.basis === 'FIXED_DEADLINE' &&
        context.timeline.deadline &&
        !timelineBody.includes(context.timeline.deadline)
      ) {
        findings.push({
          kind: 'timeline_mismatch',
          severity: 'BLOCKING',
          detectedBy: 'DETERMINISTIC',
          summary: `The client's deadline of ${context.timeline.deadline} is not stated in the timeline.`,
          action: 'Regenerate the timeline section — the deadline is part of what was approved.',
          subjectIds: [],
        });
      }
    }

    /* 4. The legal boundary. */
    const legal = prohibitedLegalTerms(everything);

    if (legal.length > 0) {
      findings.push({
        kind: 'unsupported_legal_term',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `This document contains ${legal.join(', ')}, which nobody supplied.`,
        action:
          'Remove it. Commercial and legal terms are agreed separately and listed as outstanding here — an invented clause is a liability.',
        subjectIds: [],
      });
    }

    /* 5. Internal methodology in a client document. */
    const internal = internalMethodologyTerms(everything);

    if (internal.length > 0) {
      findings.push({
        kind: 'internal_methodology_disclosed',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `This document mentions ${internal.join(', ')}.`,
        action:
          'How the work is built internally is not part of a client statement of work. Remove it, or decide deliberately to disclose it.',
        subjectIds: [],
      });
    }

    /* 6. Staffing promises nobody made. */
    const staffing = staffingClaims(everything);

    if (staffing.length > 0) {
      findings.push({
        kind: 'fictional_staffing',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `This document commits to specific staffing: "${staffing[0]}".`,
        action:
          'State responsibilities rather than headcount, unless the approved capacity plan established it.',
        subjectIds: [],
      });
    }

    /* 7. Deliverables that trace to nothing. */
    const deliverables = unsupportedDeliverables(bodyOf('deliverables'));

    if (deliverables.length > 0) {
      findings.push({
        kind: 'unsupported_deliverable',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `The deliverables include "${deliverables[0]}", which is not in the approved scope.`,
        action: 'Every deliverable has to trace to approved requirements. Remove it or scope it.',
        subjectIds: [],
      });
    }

    /* 8. Assumptions come only from the approved Assumptions document. */
    const assumptionFindings = this.assumptionFindings(input, bodyOf('assumptions'));
    findings.push(...assumptionFindings);

    /* 9. Acceptance points at the approved Acceptance Criteria. */
    const acceptance = bodyOf('acceptance');
    const criteria = context.documents.acceptanceCriteria?.criteria ?? [];

    if (acceptance.length > 0 && criteria.length === 0) {
      findings.push({
        kind: 'acceptance_misaligned',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary:
          'This document describes an acceptance process with no approved Acceptance Criteria behind it.',
        action: 'Approve the Acceptance Criteria first — this section quotes it.',
        subjectIds: [],
      });
    }

    if (acceptance.length > 0 && criteria.length > 0) {
      /*
       * A second acceptance standard is the failure here: a client with two
       * definitions of "done" has no definition of it. So the section must point at
       * the criteria document and must not state conditions of its own.
       */
      const invented = this.acceptanceConditionsNotInCriteria(acceptance, criteria);

      findings.push(
        invented.length === 0
          ? {
              kind: 'acceptance_misaligned',
              severity: 'PASS',
              detectedBy: 'DETERMINISTIC',
              summary: `Acceptance points at the approved Acceptance Criteria and its ${criteria.length} conditions.`,
              action: '',
              subjectIds: [],
            }
          : {
              kind: 'acceptance_misaligned',
              severity: 'BLOCKING',
              detectedBy: 'DETERMINISTIC',
              summary:
                'The acceptance section states conditions of its own instead of pointing at the approved Acceptance Criteria.',
              action:
                'There can only be one acceptance standard. Regenerate this section so it refers to that document.',
              subjectIds: [],
            },
      );
    }

    /* 10. Required sections, and the upstream chain. */
    const emptyRequired = REQUIRED_SOW_SECTION_KEYS.filter(
      (key) => bodyOf(key).trim().length === 0,
    );

    if (emptyRequired.length > 0) {
      findings.push({
        kind: 'empty_section',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${emptyRequired.length} section a statement of work needs is empty.`,
        action: `Write or regenerate: ${emptyRequired.join(', ')}.`,
        subjectIds: [...emptyRequired],
      });
    }

    if (!input.baselineCurrent) {
      findings.push({
        kind: 'stale_baseline',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: 'The approved requirements have changed since this document was written.',
        action: 'Regenerate it — a commercial document must describe the scope that was agreed.',
        subjectIds: [],
      });
    }

    return findings;
  }

  /** Scope reconciliation against the approved Feature Listing. */
  reconciliationFor(input: ValidationInput) {
    const features = input.context.documents.featureListing?.features ?? [];
    const functional = input.sections.find((section) => section.key === 'functional-scope');
    const scope = input.sections.find((section) => section.key === 'scope-of-work');
    const outOfScope =
      input.context.documents.understanding?.sections.find(
        (section) => section.key === 'out-of-scope',
      )?.body ?? '';

    /*
     * A feature counts as stated when its description appears in the functional
     * scope. Matching on the description rather than on the id is deliberate: the
     * ids are ours and must never reach a client document, so the check has to work
     * on the words a client actually reads.
     */
    const body = (functional?.body ?? '').toLowerCase().replace(/\s+/g, ' ');
    const statedFeatureIds = features
      .filter((feature) => {
        const description = feature.description.toLowerCase().replace(/\s+/g, ' ').trim();

        return description.length > 0 && body.includes(description);
      })
      .map((feature) => feature.featureId);

    return reconcileSowScope({
      approvedFeatureIds: features.map((feature) => feature.featureId),
      statedFeatureIds,
      exclusions: outOfScope
        .split('\n')
        .map((line) => line.replace(/^[-•\s]+/, '').trim())
        .filter((line) => line.length > 12),
      includedText: `${scope?.body ?? ''}\n${functional?.body ?? ''}`,
    });
  }

  /** Assumptions in this document that the Assumptions document does not confirm. */
  private assumptionFindings(input: ValidationInput, body: string): readonly ValidationFinding[] {
    if (body.trim().length === 0) {
      return [];
    }

    const confirmed = (input.context.documents.assumptions?.assumptions ?? []).filter(
      entersApprovedDocument,
    );

    const normalise = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
    const approved = confirmed.map((assumption) => normalise(assumption.statement));

    /* Each bullet in the section should be one of the confirmed assumptions. */
    const stated = body
      .split('\n')
      .filter((line) => line.trim().startsWith('-'))
      .map((line) => normalise(line.replace(/^[-•\s]+/, '')));

    const unapproved = stated.filter(
      (statement) => !approved.some((candidate) => candidate === statement),
    );

    if (unapproved.length === 0) {
      return [];
    }

    return [
      {
        kind: 'assumption_not_approved',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unapproved.length} assumption in this document is not a confirmed assumption of the project.`,
        action:
          'An assumption belongs in the Assumptions document first, where somebody confirms it. Take it there, then regenerate this section.',
        subjectIds: [],
      },
    ];
  }

  /**
   * Technologies named in the technology section that are not in the locked stack.
   *
   * Checked against a fixed vocabulary of common alternatives rather than by
   * guessing which words are technologies. A checker that treated every capitalised
   * word as a technology would fire constantly and be switched off.
   */
  private namedTechnologiesOutsideStack(
    body: string,
    locked: readonly string[],
  ): readonly string[] {
    const vocabulary = [
      'React',
      'Angular',
      'Vue',
      'Svelte',
      'Next.js',
      'Nuxt',
      'Django',
      'Rails',
      'Laravel',
      'Spring',
      'Express',
      'NestJS',
      'MongoDB',
      'PostgreSQL',
      'MySQL',
      'SQLite',
      'Oracle',
      'Redis',
      'Kafka',
      'RabbitMQ',
      'Elasticsearch',
      'AWS',
      'Azure',
      'Firebase',
      'Vercel',
      'Heroku',
      'Kubernetes',
      'Docker',
      'GraphQL',
      'Stripe',
      'PayPal',
      'Twilio',
      'SendGrid',
      'Auth0',
      'Okta',
    ];

    const lockedText = locked.join(' ').toLowerCase();

    return vocabulary.filter((technology) => {
      const pattern = new RegExp(`\\b${technology.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

      return pattern.test(body) && !lockedText.includes(technology.toLowerCase());
    });
  }

  /**
   * Whether the acceptance section is stating its own conditions.
   *
   * A pointer to the Acceptance Criteria is fine. A list of conditions is not,
   * unless every one of them is in that document — otherwise the client has two
   * standards and no way to tell which governs.
   */
  private acceptanceConditionsNotInCriteria(
    body: string,
    criteria: readonly AcceptanceCriterion[],
  ): readonly string[] {
    const normalise = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim();
    const known = criteria.map((criterion) => normalise(criterionText(criterion)));

    const conditions = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(-|•)?\s*(given|when|then)\b/i.test(line))
      .map(normalise);

    return conditions.filter((condition) => !known.some((entry) => entry.includes(condition)));
  }

  /** Requirements this document answers for: everything in the approved scope. */
  applicableRequirementIds(context: UpstreamContext): readonly string[] {
    return context.requirements.map((requirement) => requirement.key);
  }

  /** Whether a model may write this section. */
  modelWritable(key: string): boolean {
    return isModelWritableSowSection(key);
  }

  /** Assumptions rows are not this document's, but the type needs the hook. */
  assumptionsFrom(context: UpstreamContext): readonly Assumption[] {
    return (context.documents.assumptions?.assumptions ?? []).filter(entersApprovedDocument);
  }
}
