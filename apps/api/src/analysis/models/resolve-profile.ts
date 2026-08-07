import { InferenceError } from '../providers/inference.types';
import type { AppConfigService } from '../../config/app-config.service';
import { findModelProfile } from './model-profiles';

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
