import {
  acknowledgeableFindings,
  blockingFindings,
  type CompatibilityFinding,
} from './compatibility.contract';
import { isDecided, type StackComponentStatus } from './stack-authority.contract';
import type { StackBlocker } from './stack-snapshot.contract';
import {
  TECHNOLOGY_CATEGORY_LABELS,
  type TechnologyCategory,
} from './technology-category.contract';

/**
 * Everything standing between a stack and approval.
 *
 * Phase 4's blocker discipline, applied to technologies. Each blocker is
 * computed from stored data, each names what to do about it, and approval with
 * any of them present is refused. A gate that says "not allowed" without saying
 * why is a gate people learn to route around.
 *
 * The list is also the honest answer to *"why can I not approve this?"* — which
 * a user asks at the moment they are blocked, not in documentation.
 */

export interface StackBlockerInput {
  readonly components: readonly {
    readonly id: string;
    readonly category: TechnologyCategory;
    readonly technologyName: string;
    readonly status: StackComponentStatus;
    /** Finding ids this component has an acknowledgement for. */
    readonly acknowledgedFindingIds: readonly string[];
  }[];
  readonly requiredCategories: readonly TechnologyCategory[];
  readonly findings: readonly CompatibilityFinding[];
  readonly baselineApproved: boolean;
  readonly baselineCurrent: boolean;
  readonly projectTypeConfirmed: boolean;
  /** The project types the stack was decided against. */
  readonly decidedProjectTypes: readonly string[];
  /** The project's types now. */
  readonly currentProjectTypes: readonly string[];
}

/** Order-insensitive comparison, because the selection is a set. */
function sameTypes(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && [...first].sort().join() === [...second].sort().join();
}

export function calculateStackBlockers(input: StackBlockerInput): readonly StackBlocker[] {
  const blockers: StackBlocker[] = [];

  /*
   * The upstream gates come first, because nothing below them means anything
   * until they pass. A stack decided against draft requirements is a stack
   * decided against nothing.
   */
  if (!input.baselineApproved) {
    blockers.push({
      kind: 'baseline_not_approved',
      count: 1,
      summary: 'Your requirement baseline has not been approved.',
      action: 'Approve the baseline first — the technology decisions are made against it.',
      componentIds: [],
      findingIds: [],
    });

    return blockers;
  }

  if (!input.projectTypeConfirmed) {
    blockers.push({
      kind: 'project_type_unconfirmed',
      count: 1,
      summary: 'What kind of project this is has not been confirmed.',
      action: 'Confirm the project type. Which technologies apply follows from it.',
      componentIds: [],
      findingIds: [],
    });

    return blockers;
  }

  /*
   * The project type moved. Reported, and nothing else — the stack is not
   * replanned and no technology is removed, because which of them is now wrong
   * is a judgement rather than a calculation.
   */
  if (!sameTypes(input.decidedProjectTypes, input.currentProjectTypes)) {
    blockers.push({
      kind: 'project_type_changed',
      count: 1,
      summary: 'The project type changed after this stack was set.',
      action:
        'Review the stack against the new project type — which technologies apply follows from it.',
      componentIds: [],
      findingIds: [],
    });
  }

  if (!input.baselineCurrent) {
    blockers.push({
      kind: 'baseline_not_current',
      count: 1,
      summary: 'The requirements have changed since this stack was set.',
      action: 'Review the stack against the current baseline, then approve.',
      componentIds: [],
      findingIds: [],
    });
  }

  const live = input.components.filter(
    (component) => component.status !== 'REJECTED' && component.status !== 'SUPERSEDED',
  );

  if (live.length === 0) {
    blockers.push({
      kind: 'empty_stack',
      count: 1,
      summary: 'Nothing has been chosen yet.',
      action: 'Choose your technologies, or let the AI suggest them.',
      componentIds: [],
      findingIds: [],
    });

    return blockers;
  }

  /* A required category with nothing decided in it. */
  const decidedCategories = new Set(
    live.filter((component) => isDecided(component.status)).map((component) => component.category),
  );
  const undecided = input.requiredCategories.filter((category) => !decidedCategories.has(category));

  if (undecided.length > 0) {
    blockers.push({
      kind: 'undecided_required_category',
      count: undecided.length,
      summary: `${undecided.map((category) => TECHNOLOGY_CATEGORY_LABELS[category]).join(', ')} ${undecided.length === 1 ? 'has' : 'have'} no decision yet.`,
      action: 'Choose a technology, or accept the suggestion.',
      componentIds: [],
      findingIds: [],
    });
  }

  /*
   * A suggestion nobody has looked at. Approving a stack that still contains
   * one means approving whatever the model happened to say — which is exactly
   * the outcome the accept/reject/replace step exists to prevent.
   */
  const pending = live.filter((component) => component.status === 'AI_RECOMMENDED');

  if (pending.length > 0) {
    blockers.push({
      kind: 'undecided_recommendation',
      count: pending.length,
      summary: `${pending.length} suggestion${pending.length === 1 ? '' : 's'} ${pending.length === 1 ? 'is' : 'are'} still waiting for you.`,
      action: 'Accept, reject or replace each one.',
      componentIds: pending.map((component) => component.id),
      findingIds: [],
    });
  }

  /* A contradiction that cannot be acknowledged away. */
  const blocking = blockingFindings(input.findings);

  if (blocking.length > 0) {
    blockers.push({
      kind: 'blocking_compatibility',
      count: blocking.length,
      summary: `${blocking.length} thing${blocking.length === 1 ? '' : 's'} in this stack ${blocking.length === 1 ? 'cannot' : 'cannot'} work as chosen.`,
      action: 'Resolve each one — they contradict a requirement or cannot be built.',
      componentIds: [...new Set(blocking.flatMap((finding) => finding.componentIds))],
      findingIds: blocking.map((finding) => finding.id),
    });
  }

  /*
   * A risk the user may keep — but only after saying so. This is where user
   * authority and honest reporting meet: the choice stands, and the record
   * shows they were told.
   */
  const acknowledged = new Set(live.flatMap((component) => component.acknowledgedFindingIds));
  const unacknowledged = acknowledgeableFindings(input.findings).filter(
    (finding) => !acknowledged.has(finding.id),
  );

  if (unacknowledged.length > 0) {
    blockers.push({
      kind: 'unacknowledged_risk',
      count: unacknowledged.length,
      summary: `${unacknowledged.length} warning${unacknowledged.length === 1 ? '' : 's'} ${unacknowledged.length === 1 ? 'has' : 'have'} not been acknowledged.`,
      action: 'Read each one and either keep your choice or change it.',
      componentIds: [...new Set(unacknowledged.flatMap((finding) => finding.componentIds))],
      findingIds: unacknowledged.map((finding) => finding.id),
    });
  }

  return blockers;
}
