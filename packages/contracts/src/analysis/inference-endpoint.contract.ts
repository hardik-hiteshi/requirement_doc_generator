/**
 * Which inference endpoints this application will talk to.
 *
 * The rule is one sentence: **requirement content must not leave infrastructure
 * the operator controls.** Everything here enforces it.
 *
 * Two separate concerns, and both matter:
 *
 * 1. **No hosted model vendor.** A configured endpoint pointing at a commercial
 *    inference API is refused outright. This is a licence-and-cost constraint
 *    and a data-disclosure one at the same time.
 * 2. **No server-side request forgery.** The endpoint is operator-configured
 *    rather than user-supplied, so this is defence in depth rather than the
 *    primary control — but a configuration value that becomes an outbound
 *    request deserves the check regardless, because the day it becomes
 *    user-influenced is the day nobody remembers to add it.
 *
 * Kept in the contracts package so the same list is enforced by the API and
 * visible to anything that needs to explain the rule.
 */

/**
 * Host suffixes belonging to hosted inference vendors.
 *
 * Suffix-matched against the registrable domain, so `api.openai.com` and
 * `eu.api.openai.com` are both caught while `openai.mycompany.internal` — a
 * plausible internal name for a self-hosted OpenAI-compatible server — is not.
 *
 * This is a denylist, and a denylist is never complete. It is a second line: the
 * first is that a deployment must name its own endpoint, and there is no default
 * that reaches anywhere.
 */
export const HOSTED_INFERENCE_DOMAINS: readonly string[] = [
  'openai.com',
  'anthropic.com',
  'claude.ai',
  'googleapis.com',
  'generativelanguage.googleapis.com',
  'azure.com',
  'azure-api.net',
  'openai.azure.com',
  'cognitiveservices.azure.com',
  'amazonaws.com',
  'bedrock.amazonaws.com',
  'mistral.ai',
  'cohere.ai',
  'cohere.com',
  'together.ai',
  'together.xyz',
  'groq.com',
  'fireworks.ai',
  'replicate.com',
  'huggingface.co',
  'hf.co',
  'perplexity.ai',
  'deepseek.com',
  'x.ai',
  'openrouter.ai',
  'anyscale.com',
  'deepinfra.com',
  'lepton.ai',
  'baseten.co',
  'modal.com',
  'runpod.io',
  'vercel.ai',
  'cloudflare.com',
];

export type EndpointRejection =
  | 'not_configured'
  | 'malformed'
  | 'unsupported_scheme'
  | 'hosted_provider'
  | 'public_address'
  | 'credentials_in_url';

export interface EndpointVerdict {
  readonly allowed: boolean;
  readonly rejection?: EndpointRejection;
  /** Operator-facing explanation, safe to log and to show. */
  readonly reason?: string;
}

export interface EndpointPolicyOptions {
  /**
   * Whether the endpoint must resolve to a private address.
   *
   * Production requires it: an inference server on a public address is either a
   * vendor or an exposed one, and neither is what "self-hosted" means.
   * Development allows a public address so a machine on a lab network, or a
   * tunnel, can be used while working.
   */
  readonly requirePrivateAddress: boolean;
}

/**
 * Whether this endpoint may be used.
 *
 * Checks are ordered so the most specific, most explanatory answer wins: a
 * developer who has pasted an OpenAI URL should be told *that*, not "public
 * address not allowed".
 */
export function checkInferenceEndpoint(
  rawUrl: string,
  options: EndpointPolicyOptions,
): EndpointVerdict {
  const trimmed = rawUrl.trim();

  if (trimmed.length === 0) {
    return {
      allowed: false,
      rejection: 'not_configured',
      reason:
        'No inference endpoint is configured. There is deliberately no default: set AI_BASE_URL to a server you run.',
    };
  }

  const parsed = parseEndpoint(trimmed);

  if (!parsed) {
    return {
      allowed: false,
      rejection: 'malformed',
      reason: 'The inference endpoint is not a valid URL.',
    };
  }

  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
    return {
      allowed: false,
      rejection: 'unsupported_scheme',
      reason: `"${parsed.scheme}" is not a supported scheme. Use http or https.`,
    };
  }

  if (parsed.host.length === 0) {
    return {
      allowed: false,
      rejection: 'malformed',
      reason: 'The inference endpoint has no host.',
    };
  }

  // Credentials in the URL end up in logs, in error messages and in anything
  // that echoes a configuration value.
  if (parsed.hasCredentials) {
    return {
      allowed: false,
      rejection: 'credentials_in_url',
      reason:
        'The inference endpoint contains credentials. Put them in a header or a secret, not in a URL that gets logged.',
    };
  }

  const host = parsed.host;

  if (isHostedProvider(host)) {
    return {
      allowed: false,
      rejection: 'hosted_provider',
      reason: `"${host}" is a hosted inference provider. This application runs inference on infrastructure you control, so requirement content never leaves your network.`,
    };
  }

  if (options.requirePrivateAddress && !isPrivateHost(host)) {
    return {
      allowed: false,
      rejection: 'public_address',
      reason: `"${host}" is not a private address. In production the inference server must be on your own network.`,
    };
  }

  return { allowed: true };
}

/**
 * Splits a URL into the three parts this policy cares about.
 *
 * Hand-written because `@wdrg/contracts` is runtime-neutral by rule — no Node
 * APIs, no DOM APIs — and `URL` is neither guaranteed nor declared under the
 * package's ES2023-only lib. The parsing required is small and entirely
 * explicit, which is preferable to relaxing a constraint that exists so this
 * package can be bundled into a browser and loaded by a server unchanged.
 */
export function parseEndpoint(
  raw: string,
): { scheme: string; host: string; hasCredentials: boolean } | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(raw);

  if (!match) {
    return null;
  }

  const scheme = (match[1] ?? '').toLowerCase();
  const authority = match[2] ?? '';

  // An empty authority is reported with its scheme rather than as malformed, so
  // `file:///etc/passwd` gets the answer that explains it — "that scheme is not
  // supported" — instead of the one that does not.
  if (authority.length === 0) {
    return { scheme, host: '', hasCredentials: false };
  }

  const at = authority.lastIndexOf('@');
  const hasCredentials = at !== -1;
  const hostPort = hasCredentials ? authority.slice(at + 1) : authority;

  // Bracketed IPv6 keeps its colons; everything else splits on the port.
  const host = hostPort.startsWith('[')
    ? hostPort.slice(0, hostPort.indexOf(']') + 1) || hostPort
    : (hostPort.split(':')[0] ?? '');

  if (host.length === 0) {
    return null;
  }

  return { scheme, host: host.toLowerCase().replace(/\.$/, ''), hasCredentials };
}

/** Suffix match on the registrable domain, so subdomains are covered. */
export function isHostedProvider(host: string): boolean {
  const lower = host.toLowerCase();

  return HOSTED_INFERENCE_DOMAINS.some(
    (domain) => lower === domain || lower.endsWith(`.${domain}`),
  );
}

/**
 * Whether a host is on a private network.
 *
 * Literal addresses are checked against the private ranges. A *name* is treated
 * as private when it is a loopback name or has no public suffix — `vllm`,
 * `inference.internal`, `gpu-box.lan` — because a single-label or internal-TLD
 * name cannot resolve on the public internet.
 *
 * This does not resolve DNS. Deciding a policy question by making a network
 * request would itself be an SSRF primitive, and the answer could differ between
 * the check and the request anyway.
 */
export function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[|\]$/g, '');

  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return true;
  }

  if (isPrivateIpv4(lower) || isPrivateIpv6(lower)) {
    return true;
  }

  // Not an address, so it is a name.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower) || lower.includes(':')) {
    return false;
  }

  const labels = lower.split('.');

  // Single-label names (`vllm`, `ollama`) resolve only inside a network.
  if (labels.length === 1) {
    return true;
  }

  const tld = labels[labels.length - 1] ?? '';

  // Reserved and conventional private TLDs.
  return ['internal', 'local', 'lan', 'home', 'intranet', 'private', 'corp'].includes(tld);
}

function isPrivateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);

  if (!match) {
    return false;
  }

  const octets = match.slice(1, 5).map(Number);

  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [a = 0, b = 0] = octets;

  return (
    a === 10 || // 10.0.0.0/8
    a === 127 || // loopback
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // link-local
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 0
  );
}

function isPrivateIpv6(host: string): boolean {
  const lower = host.toLowerCase();

  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') || // unique local
    lower.startsWith('fd') ||
    lower.startsWith('fe80') // link-local
  );
}
