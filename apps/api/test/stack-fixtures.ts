import type { AiTaskId, ProjectType } from '@wdrg/contracts';

import type { DeterministicProvider } from '../src/analysis/providers/deterministic.provider';

/**
 * The thirteen project shapes Phase 5 has to get right.
 *
 * Each one exists because it is a *different* answer to "which technology
 * categories does this project have?", and getting any of them wrong produces a
 * stack full of things nobody asked for — which is then priced, written into a
 * Statement of Work, and signed.
 *
 * The hard cases are the ones where the obvious behaviour is wrong:
 *
 * - **A static website has no database.** Requiring one grows a backend.
 * - **An API service has no frontend.** Offering one invents a deliverable.
 * - **An Android app has no iOS framework**, and the reverse.
 * - **An AI project does not automatically need a vector store.** The RAG
 *   fixture and the no-RAG fixture differ only in what the requirements say,
 *   and the application has to tell them apart from that alone.
 * - **A self-hosted mandate and a commercial-cloud mandate are both legitimate**
 *   and produce opposite findings, from the same code.
 */

export interface StackFixture {
  readonly name: string;
  readonly projectTypes: readonly ProjectType[];
  readonly source: { readonly title: string; readonly text: string };
  /** Categories the plan must mark required. */
  readonly expectRequired: readonly string[];
  /** Categories the plan must mark not applicable. */
  readonly expectNotApplicable: readonly string[];
  /** Categories that must stay conditional — infrastructure nobody asked for. */
  readonly expectConditional?: readonly string[];
}

export const STACK_FIXTURES: readonly StackFixture[] = [
  {
    name: 'a static website',
    projectTypes: ['WEBSITE'],
    source: {
      title: 'Brochure site brief',
      text: [
        'The site must show five pages of company information.',
        'The content is updated by the marketing team twice a year.',
        'There is no login and nothing is submitted by visitors.',
      ].join('\n'),
    },
    expectRequired: ['web_frontend'],
    expectNotApplicable: ['native_ios', 'native_android', 'mobile_framework', 'payment'],
    expectConditional: ['cache', 'search', 'message_queue', 'vector_storage'],
  },
  {
    name: 'a standard web application',
    projectTypes: ['WEB_APPLICATION'],
    source: {
      title: 'Internal tool brief',
      text: [
        'Staff must sign in and record their weekly timesheets.',
        'A manager must approve every timesheet before it is exported.',
        'The system must keep a history of every approval.',
      ].join('\n'),
    },
    expectRequired: ['web_frontend', 'backend', 'database'],
    expectNotApplicable: ['native_ios', 'desktop_framework'],
  },
  {
    name: 'an Android and iOS mobile app',
    projectTypes: ['ANDROID_APPLICATION', 'IOS_APPLICATION'],
    source: {
      title: 'Field app brief',
      text: [
        'Engineers must record job completions on their phones.',
        'The app must work with no signal and sync when it reconnects.',
      ].join('\n'),
    },
    expectRequired: ['native_android', 'native_ios'],
    expectNotApplicable: ['web_frontend', 'desktop_framework'],
  },
  {
    name: 'an API-only service',
    projectTypes: ['BACKEND_API'],
    source: {
      title: 'Pricing service brief',
      text: [
        'The service must return a price for a given product and quantity.',
        'Prices must be stored and versioned so a quote can be reproduced.',
      ].join('\n'),
    },
    expectRequired: ['backend', 'database'],
    // The one that matters most here: an API service has no browser.
    expectNotApplicable: ['web_frontend', 'mobile_framework', 'native_ios', 'desktop_framework'],
  },
  {
    name: 'an AI application that does not need retrieval',
    projectTypes: ['AI_ML_SOLUTION'],
    source: {
      title: 'Classification brief',
      text: [
        'Incoming support emails must be sorted into one of six categories.',
        'The classification must be recorded against the email.',
      ].join('\n'),
    },
    expectRequired: ['ai_model'],
    expectNotApplicable: ['native_ios', 'desktop_framework'],
    // Nothing here describes retrieval, so a vector store stays unoffered.
    expectConditional: ['vector_storage', 'cache', 'message_queue'],
  },
  {
    name: 'an AI application where retrieval is genuinely justified',
    projectTypes: ['AI_ML_SOLUTION'],
    source: {
      title: 'Knowledge assistant brief',
      text: [
        'Staff must ask questions and get answers drawn from the policy library.',
        'The answer must cite the policy it came from, found by semantic search.',
      ].join('\n'),
    },
    expectRequired: ['ai_model'],
    expectNotApplicable: ['native_ios'],
  },
  {
    name: 'an integration-heavy system',
    projectTypes: ['SYSTEM_INTEGRATION'],
    source: {
      title: 'Middleware brief',
      text: [
        'Orders from the web shop must reach the warehouse system within an hour.',
        'The warehouse system exposes only a nightly SFTP file drop.',
        'Failed transfers must be retried and reported.',
      ].join('\n'),
    },
    expectRequired: ['integrations', 'backend'],
    expectNotApplicable: ['web_frontend', 'native_ios', 'mobile_framework'],
  },
  {
    name: 'a project with an explicit technology mandate',
    projectTypes: ['WEB_APPLICATION'],
    source: {
      title: 'Mandated stack brief',
      text: [
        'The system must use MySQL, which the client’s DBA team already supports.',
        'Staff must sign in and manage their orders.',
      ].join('\n'),
    },
    expectRequired: ['web_frontend', 'backend', 'database'],
    expectNotApplicable: ['native_ios'],
  },
  {
    name: 'a project that must be self-hosted',
    projectTypes: ['WEB_APPLICATION'],
    source: {
      title: 'On-premise brief',
      text: [
        'Everything must be self-hosted on the client’s own servers.',
        'No component may run in a public cloud.',
        'Staff must upload and retrieve case documents.',
      ].join('\n'),
    },
    expectRequired: ['web_frontend', 'backend', 'database'],
    expectNotApplicable: ['native_ios'],
  },
  {
    name: 'a project that requires a commercial cloud',
    projectTypes: ['SAAS_PLATFORM'],
    source: {
      title: 'Cloud brief',
      text: [
        'The platform must run on Amazon Web Services, which the client standardised on.',
        'Subscribers must sign in and pay monthly.',
      ].join('\n'),
    },
    expectRequired: ['web_frontend', 'backend', 'database', 'authentication'],
    expectNotApplicable: ['native_ios'],
  },
  {
    name: 'a project with only part of the stack chosen',
    projectTypes: ['WEB_APPLICATION'],
    source: {
      title: 'Partial brief',
      text: [
        'Customers must browse products and place an order.',
        'Orders must be stored and reported on.',
      ].join('\n'),
    },
    expectRequired: ['web_frontend', 'backend', 'database'],
    expectNotApplicable: ['native_ios'],
  },
  {
    name: 'a project where the user picks something incompatible',
    projectTypes: ['ANDROID_APPLICATION'],
    source: {
      title: 'Android brief',
      text: ['Drivers must scan parcels on an Android handheld device.'].join('\n'),
    },
    expectRequired: ['native_android'],
    expectNotApplicable: ['native_ios', 'web_frontend'],
  },
  {
    name: 'a multi-platform product',
    projectTypes: ['MULTI_PLATFORM_PRODUCT'],
    source: {
      title: 'Multi-platform brief',
      text: [
        'The product must be available in a browser and on phones.',
        'Data must be shared between them, and stored centrally.',
      ].join('\n'),
    },
    expectRequired: ['backend', 'database'],
    expectNotApplicable: [],
  },
];

/**
 * A scripted analysis that turns each line of a fixture into one requirement.
 *
 * Deliberately mechanical. Phase 5's tests are about technology decisions, not
 * about requirement extraction — that has its own suite — so the analysis here
 * needs only to produce a baseline that can be approved, with requirement text
 * the constraint reader can actually read.
 */
export function registerStackAnalysis(
  provider: DeterministicProvider,
  blocks: readonly { readonly id: string; readonly text: string }[],
): void {
  provider.reset();

  const respond = (taskId: AiTaskId, payload: unknown): void => {
    provider.register(taskId, JSON.stringify(payload));
  };

  /*
   * Built from the blocks the application actually produced, not from the
   * fixture's own line breaks. Pasted text is split by the ingestion layer, and
   * a fixture that assumed one block per line would cite a blockId that does
   * not exist — which the verification layer correctly rejects, failing the run
   * for a reason that has nothing to do with what is under test.
   */
  respond('requirement.normalize', {
    statements: blocks.map((block, index) => ({
      id: `s${index + 1}`,
      text: block.text,
      blockIds: [block.id],
    })),
  });

  respond('requirement.classify', {
    classifications: blocks.map((_, index) => ({
      statementId: `s${index + 1}`,
      category: 'FUNCTIONAL_REQUIREMENT',
      confidence: 0.8,
    })),
  });

  respond('requirement.extract', {
    items: blocks.map((block, index) => ({
      id: `r${index + 1}`,
      statementIds: [`s${index + 1}`],
      category: 'FUNCTIONAL_REQUIREMENT',
      title: block.text.slice(0, 70),
      description: block.text,
      // Quoted verbatim, so the application's own verification passes and the
      // requirements reach the baseline with real traceability.
      evidence: [{ blockId: block.id, excerpt: block.text }],
      confidence: 0.8,
    })),
    nonRequirementBlocks: [],
  });

  /* Nothing found. A stub inventing findings would block every fixture. */
  respond('requirement.duplicates', { groups: [] });
  respond('requirement.conflicts', { conflicts: [] });
  respond('requirement.ambiguity', { findings: [] });
  respond('requirement.missing', { findings: [] });
  respond('clarification.generate', { questions: [] });
  respond('baseline.crossSource', { findings: [] });
  respond('baseline.validate', { findings: [] });
}

/**
 * A scripted stack recommendation.
 *
 * Used where a test needs to know exactly what the model will say — that it
 * tried to overwrite a locked component, or cited a requirement that does not
 * exist, or named a technology that is not in the catalogue.
 */
export function registerStackRecommendation(
  provider: DeterministicProvider,
  payload: unknown,
): void {
  provider.register('stack.recommend', JSON.stringify(payload));
}

/**
 * A plausible suggestion for the three categories a web application needs.
 *
 * Written out rather than generated, so a test asserting "the model suggested
 * PostgreSQL" is asserting against something a reader can see. The rationales
 * cite no requirement ids, which is itself under test: a recommendation with
 * nothing behind it must be labelled an architectural derivation rather than
 * dressed up as something the client asked for.
 */
export function registerDefaultRecommendation(
  provider: DeterministicProvider,
  categories: readonly string[] = ['web_frontend', 'backend', 'database'],
): void {
  registerStackRecommendation(provider, {
    // Only the categories asked for. A recommendation for a category the
    // application did not offer is rejected by the semantic validator, which is
    // the behaviour under test elsewhere — here it would just be noise.
    recommendations: categories
      .map((category) => {
        const technologyId = DEFAULT_CHOICE[category];

        return technologyId ? recommendation(category, technologyId) : null;
      })
      .filter((item) => item !== null),
    concerns: [],
  });
}

const DEFAULT_CHOICE: Readonly<Record<string, string>> = {
  web_frontend: 'react',
  backend: 'nestjs',
  database: 'postgresql',
};

function recommendation(category: string, technologyId: string) {
  return {
    category,
    technologyId,
    rationale: `A conventional choice for the ${category} of a project like this one.`,
    requirementIds: [],
    benefits: [],
    limitations: [],
    risks: [],
    operationalConsiderations: [],
    alternativeTechnologyId: null,
    alternativeReason: null,
    modelConfidence: 0.6,
  };
}
