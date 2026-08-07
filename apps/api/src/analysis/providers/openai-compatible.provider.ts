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
 * A **self-hosted** server that speaks the OpenAI chat-completions protocol.
 *
 * vLLM, llama.cpp's server, TGI and several others implement it, which is the
 * only reason it is used here: it has become the de-facto interface for local
 * inference servers, so speaking it means a deployment can choose its engine.
 *
 * **The protocol is borrowed. The service is not.** Every request goes to
 * `AI_BASE_URL`, there is no default, and every one of them goes through the
 * same `SafeHttpClient` the Ollama adapter uses — the same vendor denylist, the
 * same resolved-address validation, the same refusal to follow a redirect. One
 * enforcement point, so the policy cannot apply to one adapter and not the
 * other. The name of this class describes a wire format; the policy is what
 * makes that safe.
 *
 * No API key is sent. A self-hosted server that wants authentication should sit
 * behind something that provides it; putting a vendor-style bearer token in this
 * adapter would be the first step towards it pointing at a vendor.
 */
@Injectable()
export class OpenAiCompatibleProvider implements InferenceProvider {
  readonly name = 'local-openai-compatible';
  private readonly logger = new Logger(OpenAiCompatibleProvider.name);

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
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      stream: false,
      // Every server that implements this protocol accepts the field; those
      // that cannot honour it ignore it, and validation catches the difference.
      ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    const response = await this.send(
      `${baseUrl}/v1/chat/completions`,
      body,
      request.timeoutMs,
      request,
    );
    const payload = parseJson<OpenAiChatResponse>(response.body);
    const choice = payload.choices?.[0];
    const content = choice?.message?.content ?? '';

    if (content.trim().length === 0) {
      throw new InferenceError('partial_response', 'The model returned an empty response.');
    }

    return {
      content,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
        cachedInputTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        durationMs: Date.now() - started,
      },
      model: payload.model ?? request.model,
      provider: this.name,
      truncated: choice?.finish_reason === 'length',
    };
  }

  async health(_profile: ModelProfile, model: string): Promise<ProviderHealth> {
    try {
      const response = await this.send(`${this.baseUrl()}/v1/models`, undefined, 10_000);
      const payload = parseJson<{ data?: { id?: string }[] }>(response.body);
      const models = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string');

      // A server that lists nothing is still usable — several serve one model
      // and implement the listing endpoint minimally. Reporting it unavailable
      // on that basis would be wrong.
      const present = models.length === 0 || models.includes(model);

      return {
        available: present,
        provider: this.name,
        models,
        ...(present ? {} : { detail: `The server does not serve "${model}".` }),
      };
    } catch (cause) {
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

  private mapHttpFailure(response: SafeResponse, request?: InferenceRequest): InferenceError {
    const lower = response.body.toLowerCase();

    if (response.status === 404 || lower.includes('model_not_found')) {
      return new InferenceError(
        'model_unavailable',
        `The model "${request?.model ?? ''}" is not served by the inference server.`,
      );
    }

    if (response.status === 503 || lower.includes('loading')) {
      return new InferenceError('model_loading', 'The model is still loading.');
    }

    if (lower.includes('context') || lower.includes('maximum context length')) {
      return new InferenceError('context_overflow', 'The request exceeded the model context.');
    }

    if (response.status === 401 || response.status === 403) {
      // Worth its own message: a self-hosted server demanding a key usually
      // means the endpoint is not the one the operator thought it was.
      return new InferenceError(
        'provider_unavailable',
        'The inference server refused the request as unauthorised. This application sends no API key — check that the endpoint is your own server.',
      );
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

interface OpenAiChatResponse {
  readonly model?: string;
  readonly choices?: {
    readonly message?: { readonly content?: string };
    readonly finish_reason?: string;
  }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  };
}
