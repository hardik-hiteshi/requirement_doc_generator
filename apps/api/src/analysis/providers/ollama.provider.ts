import { Injectable, Logger } from '@nestjs/common';
import { checkInferenceEndpoint, type ModelProfile } from '@wdrg/contracts';

import { AppConfigService } from '../../config/app-config.service';
import {
  InferenceError,
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResponse,
  type ProviderHealth,
} from './inference.types';

/**
 * Ollama, running on the operator's own machine or network.
 *
 * The development provider, and a perfectly reasonable production one for a
 * single-node deployment. One binary, one `ollama pull`, no account.
 *
 * Uses Ollama's native `/api/chat` rather than its OpenAI-compatible shim,
 * because the native API exposes two things the shim does not and both are
 * useful here: `format: "json"`, which constrains decoding to valid JSON at the
 * sampler rather than hoping the model complies, and `num_ctx`, which sets the
 * context window per request so the application's budget and the server's limit
 * cannot disagree.
 *
 * **The endpoint is policy-checked before every request.** Configuration can
 * change at runtime, and a check that only ran at startup would be a check that
 * ran once.
 */
@Injectable()
export class OllamaProvider implements InferenceProvider {
  readonly name = 'ollama';
  private readonly logger = new Logger(OllamaProvider.name);

  constructor(private readonly config: AppConfigService) {}

  async complete(request: InferenceRequest): Promise<InferenceResponse> {
    const baseUrl = this.assertEndpoint();
    const started = Date.now();

    const body = {
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: false,
      ...(request.jsonMode ? { format: 'json' } : {}),
      options: {
        temperature: request.temperature,
        num_predict: request.maxOutputTokens,
        num_ctx: this.contextTokens(),
      },
    };

    const response = await this.post(`${baseUrl}/api/chat`, body, request.timeoutMs, request);
    const payload = (await response.json()) as OllamaChatResponse;
    const content = payload.message?.content ?? '';

    if (content.trim().length === 0) {
      throw new InferenceError('partial_response', 'The model returned an empty response.');
    }

    return {
      content,
      usage: {
        inputTokens: payload.prompt_eval_count ?? 0,
        outputTokens: payload.eval_count ?? 0,
        cachedInputTokens: 0,
        durationMs: Date.now() - started,
      },
      model: payload.model ?? request.model,
      provider: this.name,
      // `length` means the output ceiling stopped it, which almost always means
      // truncated JSON — worth reporting rather than discovering at parse time.
      truncated: payload.done_reason === 'length',
    };
  }

  async health(_profile: ModelProfile, model: string): Promise<ProviderHealth> {
    let baseUrl: string;

    try {
      baseUrl = this.assertEndpoint();
    } catch (cause) {
      return {
        available: false,
        provider: this.name,
        detail: cause instanceof InferenceError ? cause.message : 'The endpoint is not usable.',
      };
    }

    try {
      const response = await this.post(`${baseUrl}/api/tags`, undefined, 10_000);
      const payload = (await response.json()) as { models?: { name?: string }[] };
      const models = (payload.models ?? [])
        .map((entry) => entry.name)
        .filter((name): name is string => typeof name === 'string');

      // Ollama reports `qwen2.5:3b-instruct`; a deployment may configure it
      // without the tag. Match either way rather than reporting a present model
      // as missing over a suffix.
      const present = models.some((name) => name === model || name.split(':')[0] === model);

      return {
        available: present,
        provider: this.name,
        models,
        ...(present
          ? {}
          : {
              detail: `The server is reachable but does not have "${model}". Run: ollama pull ${model}`,
            }),
      };
    } catch (cause) {
      return {
        available: false,
        provider: this.name,
        detail: 'The inference server is not reachable.',
        ...(cause instanceof Error ? {} : {}),
      };
    }
  }

  /**
   * Re-checks the configured endpoint and returns it without a trailing slash.
   *
   * Throwing rather than returning a verdict: a request to a disallowed endpoint
   * must not be possible to make by ignoring a return value.
   */
  private assertEndpoint(): string {
    const verdict = checkInferenceEndpoint(this.config.ai.baseUrl, {
      requirePrivateAddress: this.config.isProduction,
    });

    if (!verdict.allowed) {
      throw new InferenceError(
        'provider_unavailable',
        verdict.reason ?? 'The configured inference endpoint is not permitted.',
      );
    }

    return this.config.ai.baseUrl.trim().replace(/\/+$/, '');
  }

  private contextTokens(): number {
    return this.config.ai.maxContextTokens > 0 ? this.config.ai.maxContextTokens : 8_192;
  }

  private async post(
    url: string,
    body: unknown,
    timeoutMs: number,
    request?: InferenceRequest,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        signal: controller.signal,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (!response.ok) {
        throw await this.mapHttpFailure(response, request);
      }

      return response;
    } catch (cause) {
      if (cause instanceof InferenceError) {
        throw cause;
      }

      if (controller.signal.aborted) {
        throw new InferenceError('timeout', 'The inference request timed out.', { cause });
      }

      // Endpoint and task only. Never the messages — they are the client's
      // requirements, and a log line is not where they belong.
      this.logger.error(
        { taskId: request?.taskId, correlationId: request?.correlationId },
        'Inference request failed',
      );

      throw new InferenceError(
        'provider_unavailable',
        'The inference server could not be reached.',
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Maps Ollama's HTTP failures onto the reasons a caller acts on. */
  private async mapHttpFailure(
    response: Response,
    request?: InferenceRequest,
  ): Promise<InferenceError> {
    const text = await response.text().catch(() => '');
    const lower = text.toLowerCase();

    if (response.status === 404 || lower.includes('not found')) {
      return new InferenceError(
        'model_unavailable',
        `The model "${request?.model ?? ''}" is not installed on the inference server.`,
      );
    }

    if (lower.includes('loading') || response.status === 503) {
      return new InferenceError('model_loading', 'The model is still loading.');
    }

    if (lower.includes('context') && lower.includes('exceed')) {
      return new InferenceError('context_overflow', 'The request exceeded the model context.');
    }

    return new InferenceError(
      'provider_unavailable',
      `The inference server returned ${response.status}.`,
    );
  }
}

interface OllamaChatResponse {
  readonly model?: string;
  readonly message?: { readonly content?: string };
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
  readonly done_reason?: string;
}
