import { Injectable, Logger } from '@nestjs/common';
import {
  ANALYSIS_LIMITS,
  isRetryableAiFailure,
  type AiFailureReason,
  type AiTaskExecution,
  type AiTaskId,
  type ModelProfile,
} from '@wdrg/contracts';
import type { ZodType } from 'zod';

import { AppConfigService } from '../config/app-config.service';
import { formatEvidence, getPrompt } from './prompts/prompt-registry';
import { InferenceError, type InferenceProvider } from './providers/inference.types';
import {
  buildRepairInstruction,
  validateOutput,
  type SemanticValidator,
} from './output/structured-output';

/**
 * Runs one versioned AI task: prompt, inference, validation, bounded repair.
 *
 * Everything a task needs to be safe happens here, once, rather than in eleven
 * task implementations:
 *
 * - **Instructions and evidence stay apart.** The prompt is a `system` message
 *   built from the registry; evidence is a `user` message wrapped in delimiters.
 *   No project content is ever interpolated into an instruction.
 * - **Nothing unvalidated escapes.** The result is parsed, schema-checked and
 *   semantically checked before it is returned, so a caller cannot receive raw
 *   model output even by accident.
 * - **Repair is bounded**, and a repair prompt carries only the validation
 *   issues — never the evidence, and never the previous output.
 * - **Retries are only for failures a retry can clear.** Retrying a schema
 *   failure or a context overflow reaches the same answer more slowly.
 */

export interface TaskInput<T> {
  readonly taskId: AiTaskId;
  readonly profile: ModelProfile;
  readonly model: string;
  /** The evidence blocks, already chunked to fit. */
  readonly evidence: readonly { readonly blockId: string; readonly text: string }[];
  /**
   * Results from earlier stages that this task needs.
   *
   * A second `user` message, kept separate from the evidence so the boundary
   * stays one thing rather than two overlapping ones. Application-produced, so
   * it is not evidence — but it is also not instruction, so it is not `system`.
   */
  readonly priorResults?: string;
  readonly schema: ZodType<T>;
  readonly semantic?: SemanticValidator<T>;
  readonly correlationId: string;
  readonly chunkId?: string;
  readonly isCancelled?: () => Promise<boolean>;
}

export type TaskOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly execution: AiTaskExecution }
  | {
      readonly ok: false;
      readonly reason: AiFailureReason;
      readonly execution: AiTaskExecution;
    };

@Injectable()
export class AiTaskRunner {
  private readonly logger = new Logger(AiTaskRunner.name);

  constructor(private readonly config: AppConfigService) {}

  async run<T>(provider: InferenceProvider, input: TaskInput<T>): Promise<TaskOutcome<T>> {
    const prompt = getPrompt(input.taskId);
    const startedAt = new Date();
    const maxAttempts = this.config.ai.maxAttempts;

    let repairAttempts = 0;
    let attempt = 0;
    let lastReason: AiFailureReason = 'provider_unavailable';
    let repairInstruction: string | undefined;

    const baseMessages = [
      { role: 'system' as const, content: prompt.system },
      { role: 'user' as const, content: formatEvidence(input.evidence) },
      ...(input.priorResults
        ? [{ role: 'user' as const, content: `Earlier results:\n${input.priorResults}` }]
        : []),
    ];

    const execution = (
      succeeded: boolean,
      reason?: AiFailureReason,
      usage?: AiTaskExecution['usage'],
    ): AiTaskExecution => ({
      taskId: input.taskId,
      promptVersion: prompt.version,
      provider: provider.name,
      model: input.model,
      modelProfileId: input.profile.id,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      succeeded,
      ...(reason ? { failureReason: reason } : {}),
      repairAttempts,
      attempt: Math.max(1, attempt),
      ...(usage ? { usage } : {}),
      ...(input.chunkId ? { chunkId: input.chunkId } : {}),
    });

    while (attempt < maxAttempts) {
      attempt += 1;

      if (await input.isCancelled?.()) {
        return { ok: false, reason: 'cancelled', execution: execution(false, 'cancelled') };
      }

      try {
        const response = await provider.complete({
          messages: repairInstruction
            ? [...baseMessages, { role: 'user' as const, content: repairInstruction }]
            : baseMessages,
          model: input.model,
          jsonMode: true,
          maxOutputTokens: this.outputTokens(input.profile),
          // Zero, always: the same document must produce the same requirements.
          temperature: 0,
          timeoutMs: this.config.ai.requestTimeoutMs,
          correlationId: input.correlationId,
          taskId: input.taskId,
          ...(input.isCancelled ? { isCancelled: input.isCancelled } : {}),
        });

        if (response.truncated) {
          // The output ceiling stopped it, so the JSON is almost certainly
          // incomplete. Reported as its own reason because the fix is a smaller
          // chunk or a larger limit, not another attempt.
          lastReason = 'partial_response';
          return {
            ok: false,
            reason: lastReason,
            execution: execution(false, lastReason, response.usage),
          };
        }

        const validated = validateOutput(response.content, input.schema, input.semantic);

        if (validated.ok) {
          return {
            ok: true,
            value: validated.value,
            execution: execution(true, undefined, response.usage),
          };
        }

        lastReason = validated.reason;

        // A hallucinated citation is not a formatting mistake, and asking again
        // invites the model to invent a different one. Fail rather than repair.
        if (validated.reason === 'hallucinated_source_reference') {
          this.logger.warn(
            { taskId: input.taskId, correlationId: input.correlationId },
            'Model cited a source that does not exist; result discarded',
          );

          return {
            ok: false,
            reason: lastReason,
            execution: execution(false, lastReason, response.usage),
          };
        }

        if (repairAttempts >= ANALYSIS_LIMITS.maxRepairAttempts) {
          return {
            ok: false,
            reason: 'repair_exhausted',
            execution: execution(false, 'repair_exhausted', response.usage),
          };
        }

        repairAttempts += 1;
        // Issues only. Never the evidence, never the previous output.
        repairInstruction = buildRepairInstruction(input.taskId, validated.issues);
        // A repair is not a fresh attempt at the provider; it is another turn.
        attempt -= 1;

        this.logger.debug(
          {
            taskId: input.taskId,
            correlationId: input.correlationId,
            reason: validated.reason,
            repairAttempts,
          },
          'Asking the model to correct its output',
        );
      } catch (cause) {
        lastReason = cause instanceof InferenceError ? cause.reason : 'provider_unavailable';

        if (!isRetryableAiFailure(lastReason) || attempt >= maxAttempts) {
          return { ok: false, reason: lastReason, execution: execution(false, lastReason) };
        }

        // Linear rather than exponential: a local model that is loading becomes
        // ready in seconds, and an exponential backoff would spend most of its
        // time waiting after it already was.
        await delay(Math.min(5_000, attempt * 1_000));
      }
    }

    return { ok: false, reason: lastReason, execution: execution(false, lastReason) };
  }

  /** The profile's ceiling, unless the deployment set a smaller one. */
  private outputTokens(profile: ModelProfile): number {
    const configured = this.config.ai.maxOutputTokens;

    return configured > 0 ? Math.min(configured, profile.maxOutputTokens) : profile.maxOutputTokens;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
