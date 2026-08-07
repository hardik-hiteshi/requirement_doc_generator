import { Module } from '@nestjs/common';

import { AppConfigModule } from '../config/app-config.module';
import { AppConfigService } from '../config/app-config.service';
import { AI_PROVIDER_PORT } from '../ports';
import { findModelProfile } from './models/model-profiles';
import { EndpointGuard } from './net/endpoint-guard.service';
import { SafeHttpClient } from './net/safe-http.client';
import { DeterministicProvider } from './providers/deterministic.provider';
import { InferenceError, type InferenceProvider } from './providers/inference.types';
import { OllamaProvider } from './providers/ollama.provider';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.provider';
import { AiTaskRunner } from './task-runner.service';

/**
 * The self-hosted inference layer.
 *
 * Provider selection is configuration, never inference from `NODE_ENV`. A
 * staging environment should be able to run exactly what production runs, and
 * "it worked in development" must never mean "it used a different provider".
 *
 * `disabled` is the default and resolves to nothing: Phase 4's analysis pipeline
 * is not wired up yet, and a deployment that has not chosen a provider should
 * find that out when it tries to analyse something rather than by silently
 * getting one.
 */
@Module({
  imports: [AppConfigModule],
  providers: [
    EndpointGuard,
    SafeHttpClient,
    OllamaProvider,
    OpenAiCompatibleProvider,
    DeterministicProvider,
    AiTaskRunner,
    {
      provide: AI_PROVIDER_PORT,
      inject: [AppConfigService, OllamaProvider, OpenAiCompatibleProvider, DeterministicProvider],
      useFactory: (
        config: AppConfigService,
        ollama: OllamaProvider,
        openAiCompatible: OpenAiCompatibleProvider,
        deterministic: DeterministicProvider,
      ): InferenceProvider | null => {
        switch (config.ai.provider) {
          case 'ollama':
            return ollama;
          case 'local-openai-compatible':
            return openAiCompatible;
          case 'deterministic':
            return deterministic;
          case 'disabled':
            return null;
        }
      },
    },
  ],
  exports: [
    AI_PROVIDER_PORT,
    AiTaskRunner,
    EndpointGuard,
    SafeHttpClient,
    OllamaProvider,
    OpenAiCompatibleProvider,
    DeterministicProvider,
  ],
})
export class AnalysisModule {}

/**
 * The profile this deployment is configured to use.
 *
 * Exported as a function rather than a provider because it is a pure resolution
 * over configuration, and both the startup policy check and the eventual
 * analysis service need it before any request exists.
 */
export function resolveModelProfile(config: AppConfigService) {
  const configured = config.ai.modelProfile.trim();

  if (configured.length === 0) {
    throw new InferenceError(
      'model_unavailable',
      'No model profile is configured. Set AI_MODEL_PROFILE to one of the known profiles.',
    );
  }

  const profile = findModelProfile(configured);

  if (!profile) {
    throw new InferenceError('model_unavailable', `Unknown model profile "${configured}".`);
  }

  return profile;
}
