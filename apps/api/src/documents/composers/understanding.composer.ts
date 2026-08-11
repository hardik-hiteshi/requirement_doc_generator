import { Injectable } from '@nestjs/common';
import {
  forbiddenContent,
  REQUIRED_UNDERSTANDING_KEYS,
  UNDERSTANDING_SECTIONS,
  type DocumentReference,
  type RequirementItem,
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
 * Our Understanding, composed from the approved baseline.
 *
 * ## What the deterministic composition produces
 *
 * A complete document. Each template section gets the requirements that belong to
 * it — chosen by category, by the role and platform vocabulary the requirements
 * actually use, and by explicit out-of-scope wording — and a body that states
 * them plainly, one per line, with its key. It reads like a structured summary
 * rather than prose, because that is an honest description of what it is: the
 * requirements, organised.
 *
 * A model then rewrites those bodies into paragraphs a client would read. It is
 * given the same requirements and cannot add any. So the difference between
 * having inference and not having it is *readability*, never content — and a
 * deployment with `AI_PROVIDER=disabled` produces a document that is correct,
 * complete and slightly stiff, which is the right trade.
 *
 * ## Why a section can be empty
 *
 * Filler in this document is dangerous rather than untidy. "The system will
 * integrate with third-party services as required" is a sentence a client can
 * later hold somebody to, and it means nothing. So a section with no supporting
 * requirement is kept with a reason — visible, honest, and obviously different
 * from a heading somebody forgot.
 */
@Injectable()
export class UnderstandingComposer implements DocumentComposer {
  readonly type = 'OUR_UNDERSTANDING' as const;
  readonly shape = 'SECTIONS' as const;
  readonly requiredSectionKeys = REQUIRED_UNDERSTANDING_KEYS;

  compose(context: UpstreamContext): ComposedContent {
    const sections = UNDERSTANDING_SECTIONS.map((definition): ComposedSection => {
      const requirements = this.requirementsFor(definition.key, context);

      if (requirements.length === 0 && definition.requiresEvidence) {
        return {
          key: definition.key,
          title: definition.title,
          order: definition.order,
          body: '',
          omittedReason: `The approved requirements say nothing about this. Rather than write something generic, this section is left empty.`,
          references: [],
        };
      }

      return {
        key: definition.key,
        title: definition.title,
        order: definition.order,
        body: this.bodyFor(definition.key, requirements, context),
        references: requirements.map(requirementReference).slice(0, 200),
      };
    });

    return { sections, features: [] };
  }

  applicableRequirementIds(context: UpstreamContext): readonly string[] {
    /*
     * Everything in the baseline. Understanding is the document that says what
     * the client asked for, so a requirement missing from it is a requirement
     * nobody has acknowledged.
     */
    return context.requirements.map((requirement) => requirement.key);
  }

  /**
   * Which requirements belong under a heading.
   *
   * Category first, because Phase 4 already classified them and re-deciding here
   * would be a second opinion nobody asked for. Where a heading is not a
   * category — modules, workflows, platforms — the selection is by the words the
   * requirements themselves use, and a heading with no match is left empty rather
   * than filled from the nearest thing.
   */
  private requirementsFor(key: string, context: UpstreamContext): readonly RequirementItem[] {
    const byCategory = (...categories: string[]): readonly RequirementItem[] =>
      context.requirements.filter((requirement) => categories.includes(requirement.category));

    const matching = (pattern: RegExp): readonly RequirementItem[] =>
      context.requirements.filter(
        (requirement) => pattern.test(requirement.title) || pattern.test(requirement.statement),
      );

    switch (key) {
      case 'project-overview':
        return context.requirements.slice(0, 8);
      case 'business-objective':
        return matching(/\b(objective|goal|so that|in order to|reduce|improve|increase)\b/i);
      case 'solution-understanding':
        return byCategory('functional').slice(0, 12);
      case 'intended-users':
        return byCategory('user_role');
      case 'major-modules':
        return byCategory('functional');
      case 'core-workflows':
        return matching(/\b(then|after|before|approve|submit|workflow|process|step)\b/i);
      case 'functional-scope':
        return byCategory('functional', 'business_rule');
      case 'non-functional':
        return byCategory('non_functional');
      case 'integrations':
        return byCategory('integration');
      case 'data-reporting':
        return byCategory('data');
      case 'platforms':
        return matching(/\b(web|mobile|ios|android|desktop|browser|tablet|api)\b/i);
      case 'constraints':
        return byCategory('constraint');
      case 'out-of-scope':
        return matching(/\b(out of scope|not included|excluded|will not|no support for)\b/i);
      case 'clarifications':
        // Clarifications are their own evidence; requirement selection does not
        // apply, and the body is built from the confirmed answers directly.
        return context.clarifications.length > 0 ? context.requirements.slice(0, 1) : [];
      case 'open-items':
        return context.requirements.filter((requirement) => requirement.needsRevalidation);
      default:
        return [];
    }
  }

  /** A plain, checkable body. The model's job is to make this read well. */
  private bodyFor(
    key: string,
    requirements: readonly RequirementItem[],
    context: UpstreamContext,
  ): string {
    if (key === 'project-overview') {
      const types = context.projectTypes.length > 0 ? context.projectTypes.join(', ') : 'system';

      return [
        `${context.projectName} is a ${types.toLowerCase()} described by ${context.requirements.length} approved requirements.`,
        'The sections below set out what those requirements say, organised by subject.',
      ].join(' ');
    }

    if (key === 'clarifications') {
      return context.clarifications
        .map((entry) => `${entry.label}: ${entry.question} — ${entry.answer}`)
        .join('\n');
    }

    if (key === 'open-items') {
      return requirements
        .map((requirement) => `${requirement.title} — this has changed since it was last checked.`)
        .join('\n');
    }

    /*
     * Statements only. The requirement ids are on the section's `references`, where
     * the interface shows them under "Where this comes from" — putting them in the
     * prose would mean a client-facing copy carried our identifiers.
     */
    return requirements.map((requirement) => requirement.statement).join('\n');
  }

  /**
   * Deterministic checks, in the order a reader cares about them.
   *
   * Every one of these is arithmetic over stored data. The model's contribution
   * to validation is separate, additive, and labelled as a judgement — see
   * `documents-ai.service.ts`.
   */
  validate(input: ValidationInput): readonly ValidationFinding[] {
    const findings: ValidationFinding[] = [];
    const approved = new Map(
      input.context.requirements.map((requirement) => [requirement.key, requirement]),
    );

    /*
     * 1. Every cited requirement exists, and none of them is one we rejected.
     *
     * `cited` is what the application recorded. `mentioned` is what appears in the
     * prose — the two are checked for different things: coverage against the first,
     * fabricated ids against the second.
     */
    const cited = new Set(input.sections.flatMap((section) => section.references));
    const mentioned = new Set(
      input.sections.flatMap((section) =>
        [...section.body.matchAll(/\bREQ-\d{3,5}\b/g)].map((match) => match[0]),
      ),
    );

    const unknown = [...new Set([...cited, ...mentioned])].filter((key) => !approved.has(key));
    const rejected = input.context.allRequirements.filter(
      (requirement) =>
        (cited.has(requirement.key) || mentioned.has(requirement.key)) &&
        requirement.status === 'rejected',
    );
    const superseded = input.context.allRequirements.filter(
      (requirement) =>
        (cited.has(requirement.key) || mentioned.has(requirement.key)) &&
        requirement.status === 'superseded',
    );

    if (unknown.length > 0) {
      findings.push({
        kind: 'unknown_requirement',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${unknown.length} requirement reference${unknown.length === 1 ? '' : 's'} in this document ${unknown.length === 1 ? 'does' : 'do'} not exist in your baseline.`,
        action: 'Regenerate the document — a citation to nothing cannot be checked by a reader.',
        subjectIds: unknown,
      });
    }

    if (rejected.length > 0) {
      findings.push({
        kind: 'rejected_requirement_present',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${rejected.length} requirement${rejected.length === 1 ? '' : 's'} you rejected ${rejected.length === 1 ? 'appears' : 'appear'} in this document.`,
        action:
          'Regenerate it. A rejected requirement in a client document is scope nobody agreed to.',
        subjectIds: rejected.map((requirement) => requirement.key),
      });
    }

    if (superseded.length > 0) {
      findings.push({
        kind: 'superseded_requirement_present',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${superseded.length} superseded requirement${superseded.length === 1 ? '' : 's'} ${superseded.length === 1 ? 'appears' : 'appear'} instead of what replaced ${superseded.length === 1 ? 'it' : 'them'}.`,
        action: 'Regenerate the document so it cites the requirements that are current.',
        subjectIds: superseded.map((requirement) => requirement.key),
      });
    }

    /* 2. The baseline it was written against is the current one. */
    if (!input.baselineCurrent) {
      findings.push({
        kind: 'stale_baseline',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: 'This document was written against a baseline that is no longer current.',
        action: 'Regenerate it against the approved baseline as it stands now.',
        subjectIds: [],
      });
    }

    /* 3. Coverage: every approved requirement is acknowledged somewhere. */
    const applicable = this.applicableRequirementIds(input.context);
    const excluded = new Set(input.excludedRequirementIds);
    const uncovered = applicable.filter(
      (key) => !cited.has(key) && !mentioned.has(key) && !excluded.has(key),
    );

    findings.push(
      uncovered.length === 0
        ? {
            kind: 'requirement_uncovered',
            severity: 'PASS',
            detectedBy: 'DETERMINISTIC',
            summary: `All ${applicable.length} approved requirements are represented.`,
            action: '',
            subjectIds: [],
          }
        : {
            kind: 'requirement_uncovered',
            severity: 'WARNING',
            detectedBy: 'DETERMINISTIC',
            summary: `${uncovered.length} approved requirement${uncovered.length === 1 ? ' is' : 's are'} not mentioned anywhere in this document.`,
            action:
              'Regenerate, or add them to the relevant section — a requirement the client cannot find is one they have not agreed to.',
            subjectIds: uncovered.slice(0, 200),
          },
    );

    /* 4. Nothing invented, and no internal methodology. */
    for (const section of input.sections) {
      for (const { match, reason } of forbiddenContent(section.body)) {
        findings.push({
          kind: 'unsupported_statement',
          severity: 'BLOCKING',
          detectedBy: 'DETERMINISTIC',
          summary: `"${match}" in ${section.key} is ${reason}.`,
          action: 'Remove it, or add the requirement that states it and regenerate.',
          subjectIds: [section.key],
        });
      }
    }

    /* 5. A blocking issue upstream is not hidden by a confident document. */
    if (input.context.upstreamBlockers.length > 0) {
      findings.push({
        kind: 'hidden_blocker',
        severity: 'WARNING',
        detectedBy: 'DETERMINISTIC',
        summary: `${input.context.upstreamBlockers.length} unresolved issue${input.context.upstreamBlockers.length === 1 ? '' : 's'} upstream ${input.context.upstreamBlockers.length === 1 ? 'is' : 'are'} not reflected here.`,
        action: 'Resolve them in the earlier steps, or say so in Open Items.',
        subjectIds: input.context.upstreamBlockers.map((blocker) => blocker.kind),
      });
    }

    /* 6. Scope and out-of-scope do not contradict each other. */
    const scope = input.sections.find((section) => section.key === 'functional-scope');
    const outOfScope = input.sections.find((section) => section.key === 'out-of-scope');
    const contradictions = this.contradictions(scope, outOfScope);

    if (contradictions.length > 0) {
      findings.push({
        kind: 'scope_contradiction',
        severity: 'BLOCKING',
        detectedBy: 'DETERMINISTIC',
        summary: `${contradictions.join(', ')} appears in both the scope and the out-of-scope section.`,
        action: 'Decide which one is right. A document that says both is unusable as an agreement.',
        subjectIds: ['functional-scope', 'out-of-scope'],
      });
    }

    /* 7. Required sections have content. */
    for (const key of this.requiredSectionKeys) {
      const section = input.sections.find((candidate) => candidate.key === key);

      if (!section || section.body.trim().length === 0) {
        findings.push({
          kind: 'empty_section',
          severity: 'BLOCKING',
          detectedBy: 'DETERMINISTIC',
          summary: `${key} is empty, and this document cannot be approved without it.`,
          action: 'Write it, or regenerate the document.',
          subjectIds: [key],
        });
      }
    }

    return findings;
  }

  /**
   * Requirement keys claimed by both the scope and the out-of-scope section.
   *
   * Compared on keys rather than on wording: the same requirement cited in both
   * places is a definite contradiction, whereas two sentences that merely sound
   * similar are a judgement, and judgement belongs to the model's half of
   * validation.
   */
  private contradictions(
    scope: { readonly body: string; readonly references: readonly string[] } | undefined,
    outOfScope: { readonly body: string; readonly references: readonly string[] } | undefined,
  ): readonly string[] {
    const keys = (
      section: { readonly body: string; readonly references: readonly string[] } | undefined,
    ): Set<string> =>
      new Set([
        ...(section?.references ?? []),
        ...[...(section?.body ?? '').matchAll(/\bREQ-\d{3,5}\b/g)].map((match) => match[0]),
      ]);

    const inScope = keys(scope);

    return [...keys(outOfScope)].filter((key) => inScope.has(key)).sort();
  }
}

/** Reference list for a section, deduplicated by id. Used by the AI path too. */
export function dedupeReferences(
  references: readonly DocumentReference[],
): readonly DocumentReference[] {
  const seen = new Map<string, DocumentReference>();

  for (const reference of references) {
    if (!seen.has(reference.id)) {
      seen.set(reference.id, reference);
    }
  }

  return [...seen.values()];
}
