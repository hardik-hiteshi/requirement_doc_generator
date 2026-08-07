import { EVIDENCE_CLOSE, EVIDENCE_OPEN } from '../prompts/prompt-registry';
import type { InferenceRequest } from './inference.types';

/**
 * A stub that answers from the evidence it was given.
 *
 * The browser suite runs the API as a separate process, so it cannot register
 * fixtures the way an in-process test does — and the text it types is whatever
 * the scenario needs it to be. A fixture table keyed by expected input would
 * have to be kept in step with every test that pastes a different sentence.
 *
 * So this echoes instead: each requirement statement comes back as a
 * requirement item citing the block it came from, verbatim. That makes it a
 * *real* exercise of the parts under test — traceability, verification,
 * chunking, coverage, the approval gate — while the model's contribution is
 * reduced to a mechanical transformation.
 *
 * **It is not a model, and it does not pretend to be one.** It finds no
 * conflicts and asks no questions, because inventing either from a stub would
 * put fiction on a screen that is otherwise showing facts. Tests that need a
 * conflict use the in-process fixtures, where the scenario is written down.
 *
 * Enabled only with `AI_PROVIDER=deterministic`, which production refuses at
 * startup.
 */
export function echoResponse(request: InferenceRequest): string | null {
  const blocks = parseEvidence(request);

  switch (request.taskId) {
    case 'requirement.normalize':
      return JSON.stringify({
        statements: blocks.map((block, index) => ({
          id: `s${index + 1}`,
          text: block.text,
          blockIds: [block.blockId],
        })),
      });

    case 'requirement.classify':
      return JSON.stringify({
        classifications: blocks.map((block, index) => ({
          statementId: `s${index + 1}`,
          category: categoryFor(block.text),
          confidence: 0.8,
        })),
      });

    case 'requirement.extract':
      return JSON.stringify({
        items: blocks
          .filter((block) => looksLikeRequirement(block.text))
          .map((block, index) => ({
            id: `r${index + 1}`,
            statementIds: [`s${index + 1}`],
            category: categoryFor(block.text),
            title: block.text.slice(0, 80),
            description: block.text,
            // Quoted verbatim, so the application's verification finds it —
            // which is what makes the traceability shown on screen real.
            evidence: [{ blockId: block.blockId, excerpt: block.text }],
            confidence: 0.8,
          })),
        nonRequirementBlocks: blocks
          .filter((block) => !looksLikeRequirement(block.text))
          .map((block) => ({
            blockId: block.blockId,
            reason: 'This line does not state a requirement.',
          })),
      });

    /*
     * Nothing found, deliberately. A stub inventing a contradiction would put
     * a fabricated finding in front of a reviewer, which is precisely the
     * failure the whole phase is built to prevent.
     */
    case 'requirement.duplicates':
      return JSON.stringify({ groups: [] });
    case 'requirement.conflicts':
      return JSON.stringify({ conflicts: [] });
    case 'requirement.ambiguity':
      return JSON.stringify({ findings: [] });
    case 'requirement.missing':
      return JSON.stringify({ findings: [] });
    case 'baseline.crossSource':
      return JSON.stringify({ findings: [] });
    case 'baseline.validate':
      return JSON.stringify({ findings: [] });

    /*
     * Never settles a conflict.
     *
     * A stub cannot read two statements and judge whether an answer reconciles
     * them, and guessing "yes" would let it clear a blocker on a document
     * somebody signs. Withholding is the only honest answer, and it is exactly
     * what the veto is for.
     */
    case 'conflict.reevaluate':
      return JSON.stringify({
        evaluations: blocks.map((block) => ({
          conflictId: block.blockId,
          settled: false,
          reason: 'This stub does not judge whether an answer settles a contradiction.',
        })),
      });
    /*
     * One question, derived mechanically.
     *
     * A stub inventing a *finding* would put fiction in front of a reviewer.
     * This is different in kind: it fires only where the evidence literally
     * contains an unqualified "users", and the question it asks is which ones.
     * That is a transformation of the input, like the requirement echo above,
     * and it exists so the browser suite can exercise the whole
     * answer → confirm → integrate → propose path without a model.
     */
    case 'clarification.generate': {
      const vague = blocks.find((block) => /\busers\b/i.test(block.text));

      return JSON.stringify({
        questions: vague
          ? [
              {
                id: 'q1',
                question: 'Which users does this apply to?',
                reason: 'The wording says "users" without saying which.',
                category: 'MISSING_DETAIL',
                impact: 'BLOCKING',
                itemIds: ['REQ-001'],
              },
            ]
          : [],
      });
    }

    /*
     * The confirmed answer joined onto the requirement it qualifies.
     *
     * Deliberately a join rather than a rewrite: a stub that produced fluent
     * prose would make the browser suite look like it was testing a model's
     * writing. What it is testing is that the update lands, is traced to the
     * clarification, and respects the preservation rules.
     */
    case 'clarification.integrate': {
      const question = blocks[0];
      const requirement = blocks[1];
      const answer = question?.text.split('Confirmed answer:')[1]?.trim() ?? '';
      const statement = requirement?.text.split(': ').slice(1).join(': ') ?? '';

      return JSON.stringify({
        updates:
          requirement && answer
            ? [
                {
                  itemId: requirement.blockId,
                  description: `${statement} ${answer}`.trim(),
                  resolvedFindingIds: [],
                },
              ]
            : [],
        newRequirements: [],
      });
    }

    default:
      return null;
  }
}

interface EvidenceBlock {
  readonly blockId: string;
  readonly text: string;
}

/**
 * Reads the delimited evidence back out of the request.
 *
 * **Only `user` messages.** The system prompt names both delimiters — it has to,
 * because it is telling the model what they mean — so searching the messages
 * joined together finds the preamble's mention first and slices out instructions
 * instead of evidence. That produced an analysis that ran, succeeded, and
 * returned nothing, which is exactly the sort of silent emptiness this stub is
 * supposed to help catch rather than cause. Found by the browser suite.
 */
function parseEvidence(request: InferenceRequest): EvidenceBlock[] {
  for (const message of request.messages) {
    if (message.role !== 'user') {
      continue;
    }

    const blocks = parseDelimited(message.content);

    if (blocks.length > 0) {
      return blocks;
    }
  }

  return [];
}

function parseDelimited(content: string): EvidenceBlock[] {
  const start = content.indexOf(EVIDENCE_OPEN);
  const end = content.indexOf(EVIDENCE_CLOSE, start + EVIDENCE_OPEN.length);

  if (start === -1 || end === -1) {
    return [];
  }

  const body = content.slice(start + EVIDENCE_OPEN.length, end).trim();

  return body
    .split('\n\n')
    .flatMap((entry) => {
      const match = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(entry.trim());

      return match?.[1] && match[2]?.trim() ? [{ blockId: match[1], text: match[2].trim() }] : [];
    })
    .slice(0, 100);
}

/** A crude classifier, and it says so. Enough to exercise the UI's filters. */
function categoryFor(text: string): string {
  const lower = text.toLowerCase();

  if (/\b(within|second|minute|hour|performance|available|secure|encrypt)\b/.test(lower)) {
    return 'NON_FUNCTIONAL_REQUIREMENT';
  }

  if (/\b(approve|approval|policy|rule|only|must not)\b/.test(lower)) {
    return 'BUSINESS_RULE';
  }

  return 'FUNCTIONAL_REQUIREMENT';
}

/** Page furniture is not a requirement. Neither is a bare heading. */
function looksLikeRequirement(text: string): boolean {
  return text.trim().length > 20 && !/^page\s+\d+/i.test(text.trim());
}
