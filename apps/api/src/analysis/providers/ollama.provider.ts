import { Injectable, Logger } from '@nestjs/common';
import type { ModelProfile } from '@wdrg/contracts';

import { AppConfigService } from '../../config/app-config.service';
import { SafeHttpClient, type SafeResponse } from '../net/safe-http.client';
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
 * **Every request goes through `SafeHttpClient`**, which re-applies the endpoint
 * policy, resolves and validates the destination, connects to the validated
 * address rather than to a name, and refuses redirects. A check that only ran at
 * startup would be a check that ran once, against a destination that can change
 * underneath it.
 */
@Injectable()
export class OllamaProvider implements InferenceProvider {
  readonly name = 'ollama';
  private readonly logger = new Logger(OllamaProvider.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly http: SafeHttpClient,
  ) {}

  async complete(request: InferenceRequest): Promise<InferenceResponse> {
    const baseUrl = this.baseUrl();
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

    const response = await this.send(`${baseUrl}/api/chat`, body, request.timeoutMs, request);
    const payload = parseJson<OllamaChatResponse>(response.body);
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
    try {
      const response = await this.send(`${this.baseUrl()}/api/tags`, undefined, 10_000);
      const payload = parseJson<{ models?: { name?: string }[] }>(response.body);
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
      // The endpoint being refused and the server being down are different
      // problems with different fixes, so they get different messages.
      return {
        available: false,
        provider: this.name,
        detail:
          cause instanceof InferenceError
            ? cause.message
            : 'The inference server is not reachable.',
      };
    }
  }

  private baseUrl(): string {
    return this.config.ai.baseUrl.trim().replace(/\/+$/, '');
  }

  private contextTokens(): number {
    return this.config.ai.maxContextTokens > 0 ? this.config.ai.maxContextTokens : 8_192;
  }

  private async send(
    url: string,
    body: unknown,
    timeoutMs: number,
    request?: InferenceRequest,
  ): Promise<SafeResponse> {
    try {
      const response = await this.http.send({
        url,
        method: body === undefined ? 'GET' : 'POST',
        timeoutMs,
        ...(body === undefined ? {} : { body }),
        ...(request?.correlationId ? { correlationId: request.correlationId } : {}),
      });

      if (response.status >= 400) {
        throw this.mapHttpFailure(response, request);
      }

      return response;
    } catch (cause) {
      if (cause instanceof InferenceError) {
        throw cause;
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
    }
  }

  /** Maps Ollama's HTTP failures onto the reasons a caller acts on. */
  private mapHttpFailure(response: SafeResponse, request?: InferenceRequest): InferenceError {
    const lower = response.body.toLowerCase();

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

function parseJson<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (cause) {
    throw new InferenceError(
      'invalid_json',
      'The inference server returned a response that is not JSON.',
      { cause },
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
