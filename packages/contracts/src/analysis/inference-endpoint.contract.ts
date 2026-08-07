/**
 * Which inference endpoints this application will talk to.
 *
 * The rule is one sentence: **requirement content must not leave infrastructure
 * the operator controls.** Everything here enforces it.
 *
 * Three separate concerns, and all of them matter:
 *
 * 1. **No hosted model vendor.** A configured endpoint pointing at a commercial
 *    inference API is refused outright. This is a licence-and-cost constraint
 *    and a data-disclosure one at the same time.
 * 2. **No server-side request forgery.** The endpoint is operator-configured
 *    rather than user-supplied, so this is defence in depth rather than the
 *    primary control — but a configuration value that becomes an outbound
 *    request carrying a client's confidential requirements deserves the full
 *    check regardless, because the day it becomes user-influenced is the day
 *    nobody remembers to add one.
 * 3. **No reaching somewhere that only looks internal.** Cloud metadata
 *    services, wildcard DNS reflectors and tunnelling services all present as
 *    ordinary hostnames. Each is named here.
 *
 * This module is deliberately *pure*. It classifies literal addresses and
 * validates addresses somebody else resolved; it never performs DNS itself.
 * `@wdrg/contracts` is runtime-neutral by rule, and — more importantly —
 * resolving a name in order to decide a policy question would itself be an
 * outbound request, made before any policy had been applied to it. The API's
 * endpoint guard does the resolving and hands the results back here.
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
 * that reaches anywhere. The third is that in production the resolved address
 * must be internal, which catches a vendor this list has never heard of.
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

/**
 * Services whose whole purpose is making one host reachable as another.
 *
 * Two families, refused for the same reason. **Wildcard DNS reflectors**
 * (`nip.io` and friends) resolve any name of the form `10.0.0.1.nip.io` to the
 * address embedded in it, which turns a hostname allowlist into no allowlist at
 * all. **Tunnelling services** do the reverse: they publish something on the
 * operator's machine at a public address, so "the inference server is local"
 * stops being true the moment one is in the path.
 *
 * Either way the destination is not what the hostname suggests, and requirement
 * content would traverse a third party to reach it.
 */
export const LOOP_THROUGH_DOMAINS: readonly string[] = [
  // Wildcard DNS reflectors.
  'nip.io',
  'sslip.io',
  'xip.io',
  'ip6.name',
  'traefik.me',
  'localtest.me',
  'lvh.me',
  'vcap.me',
  '1u.ms',
  // Tunnels.
  'ngrok.io',
  'ngrok.app',
  'ngrok.dev',
  'ngrok-free.app',
  'localhost.run',
  'serveo.net',
  'trycloudflare.com',
  'loca.lt',
  'pagekite.me',
  'tunnelto.dev',
  'bore.pub',
];

/**
 * Hostnames that reach a cloud provider's instance metadata service.
 *
 * The prize behind an SSRF in a cloud deployment: instance credentials, in
 * plain text, from an endpoint that requires no authentication because it
 * assumes only the instance can reach it. Several of these look internal by
 * every other measure — `metadata.google.internal` ends in `.internal`, and
 * `metadata` is a single-label name — so they are checked before anything that
 * would accept them on that basis.
 */
export const METADATA_HOSTNAMES: readonly string[] = [
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.packet.net',
  'metadata.platformequinix.com',
];

/** Literal addresses belonging to a metadata service. */
export const METADATA_ADDRESSES: readonly string[] = [
  '169.254.169.254', // AWS, Azure, GCP, OpenStack, DigitalOcean
  '169.254.170.2', // ECS task metadata
  '169.254.169.253', // AWS VPC DNS
  '100.100.100.200', // Alibaba Cloud
  '192.0.0.192', // Oracle Cloud
  'fd00:ec2::254', // AWS IMDS over IPv6
];

/* ------------------------------------------------------ address classes */

/**
 * What an IP address *is*, rather than whether it happens to be allowed.
 *
 * Separating the two matters: the policy differs between development and
 * production, but the classification never does, so a single well-tested
 * function answers the hard part and the policy reads as a short list of which
 * classes it accepts.
 */
export type AddressClass =
  | 'loopback'
  /** RFC 1918 and IPv6 unique-local: the ranges "internal network" means. */
  | 'private'
  | 'link_local'
  | 'metadata'
  | 'multicast'
  | 'unspecified'
  | 'broadcast'
  /** Carrier-grade NAT (100.64/10). Shared with a carrier, not internal. */
  | 'shared'
  /** Documentation, benchmarking, future-use, IETF protocol assignments. */
  | 'reserved'
  | 'public'
  /** Syntactically an address, but not one this application will accept. */
  | 'malformed';

export type EndpointRejection =
  | 'not_configured'
  | 'malformed'
  | 'unsupported_scheme'
  | 'hosted_provider'
  | 'loop_through_service'
  | 'metadata_endpoint'
  | 'public_address'
  | 'link_local_address'
  | 'multicast_address'
  | 'unspecified_address'
  | 'reserved_address'
  | 'malformed_address'
  | 'credentials_in_url'
  | 'no_addresses'
  | 'mixed_addresses'
  | 'redirect_refused';

export interface EndpointVerdict {
  readonly allowed: boolean;
  readonly rejection?: EndpointRejection;
  /** Operator-facing explanation, safe to log and to show. */
  readonly reason?: string;
}

export interface EndpointPolicyOptions {
  /**
   * Whether the endpoint must be on an internal address.
   *
   * Production requires it: an inference server on a public address is either a
   * vendor or an exposed one, and neither is what "self-hosted" means.
   * Development allows a public address so a machine on a lab network can be
   * used while working.
   */
  readonly requirePrivateAddress: boolean;
  /**
   * Whether loopback is refused as well.
   *
   * Off by default, because "the model runs on this box" is the most common
   * — and entirely legitimate — production shape for a self-hosted deployment
   * of this size. A deployment whose policy requires inference to be a separate
   * internal host turns it on, and then `127.0.0.1` is refused in production
   * along with everything else that is not a private-range address.
   */
  readonly rejectLoopback?: boolean;
}

/* --------------------------------------------------------- URL policy */

/**
 * Whether this endpoint may be used, judged from the URL alone.
 *
 * This is the *syntactic* half of the policy: scheme, credentials, vendor
 * denylists, and the classification of a literal address if the host is one. A
 * hostname that has to be resolved is left to {@link checkResolvedAddresses},
 * which the API calls with the answers DNS gave — because a name that passes
 * here can still resolve somewhere this application must not reach.
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

  return checkHost(parsed.host, options);
}

/**
 * The host half of the policy, without the URL around it.
 *
 * Exported because a redirect's `Location` gives a host to judge, and the same
 * rules must apply to it as applied to the configured endpoint.
 */
export function checkHost(rawHost: string, options: EndpointPolicyOptions): EndpointVerdict {
  const host = rawHost
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  // Before anything that could accept them for looking internal: a metadata
  // hostname is a single-label name or ends in `.internal`, and the IPv6 AWS
  // metadata address sits inside the unique-local range.
  if (isMetadataHost(host)) {
    return {
      allowed: false,
      rejection: 'metadata_endpoint',
      reason: `"${host}" is a cloud instance metadata endpoint, which serves instance credentials to anything that can reach it. It is never an inference server.`,
    };
  }

  if (isHostedProvider(host)) {
    return {
      allowed: false,
      rejection: 'hosted_provider',
      reason: `"${host}" is a hosted inference provider. This application runs inference on infrastructure you control, so requirement content never leaves your network.`,
    };
  }

  if (isLoopThroughService(host)) {
    return {
      allowed: false,
      rejection: 'loop_through_service',
      reason: `"${host}" belongs to a wildcard-DNS or tunnelling service, so the real destination is not the one the hostname describes. Name the inference server directly.`,
    };
  }

  const literal = classifyAddress(host);

  if (literal !== null) {
    return verdictForClass(host, literal, options);
  }

  // A name. Whether it is acceptable depends on what it resolves to, which is
  // not knowable here — the guard resolves it and calls checkResolvedAddresses.
  // Outside production a name is accepted on its face.
  if (options.requirePrivateAddress && !isInternalName(host)) {
    return {
      allowed: false,
      rejection: 'public_address',
      reason: `"${host}" is a publicly-resolvable name. In production the inference server must be on your own network.`,
    };
  }

  return { allowed: true };
}

/**
 * Whether every address a hostname resolved to may be connected to.
 *
 * The half of the policy that a URL cannot answer. Three properties, and the
 * third is the one that is easy to miss:
 *
 * - **Every** address is checked, not the first. A name that returns one
 *   private and one public address is refused outright rather than accepted on
 *   the strength of whichever the resolver happened to order first, because the
 *   resolver's order is not a guarantee and the next lookup may differ.
 * - **An empty result is a refusal**, not a pass. "Nothing to object to" is not
 *   the same as "checked and fine".
 * - The reason names the *class* that failed, never the address, so a log line
 *   does not become an internal-network map.
 */
export function checkResolvedAddresses(
  host: string,
  addresses: readonly string[],
  options: EndpointPolicyOptions,
): EndpointVerdict {
  if (addresses.length === 0) {
    return {
      allowed: false,
      rejection: 'no_addresses',
      reason: `"${host}" did not resolve to any address.`,
    };
  }

  const verdicts = addresses.map((address) => {
    const classified = classifyAddress(address);

    return classified === null
      ? verdictForClass(host, 'malformed', options)
      : verdictForClass(host, classified, options);
  });

  const refused = verdicts.filter((verdict) => !verdict.allowed);

  if (refused.length === 0) {
    return { allowed: true };
  }

  // Some allowed, some not: a split-horizon or round-robin name that would
  // succeed or fail depending on the moment. That is worse than a name which
  // simply points somewhere wrong, so it gets its own reason.
  if (refused.length < verdicts.length) {
    return {
      allowed: false,
      rejection: 'mixed_addresses',
      reason: `"${host}" resolves to both permitted and forbidden addresses, so where a request would go depends on the resolver. Point it at one server.`,
    };
  }

  return refused[0] ?? { allowed: false, rejection: 'no_addresses' };
}

function verdictForClass(
  host: string,
  addressClass: AddressClass,
  options: EndpointPolicyOptions,
): EndpointVerdict {
  switch (addressClass) {
    case 'metadata':
      return {
        allowed: false,
        rejection: 'metadata_endpoint',
        reason: `"${host}" reaches a cloud instance metadata service, which serves instance credentials to anything that can reach it.`,
      };

    case 'link_local':
      return {
        allowed: false,
        rejection: 'link_local_address',
        reason: `"${host}" is a link-local address. Those reach whatever answers on the local segment, including metadata services, so they are never an inference server.`,
      };

    case 'multicast':
      return {
        allowed: false,
        rejection: 'multicast_address',
        reason: `"${host}" is a multicast address, which is not a single server.`,
      };

    case 'unspecified':
    case 'broadcast':
      return {
        allowed: false,
        rejection: 'unspecified_address',
        reason: `"${host}" is not a routable destination. Name the server's own address.`,
      };

    case 'shared':
    case 'reserved':
      return {
        allowed: false,
        rejection: 'reserved_address',
        reason: `"${host}" is in a reserved range that is neither your network nor a valid server address.`,
      };

    case 'malformed':
      return {
        allowed: false,
        rejection: 'malformed_address',
        reason: `"${host}" is not a plain dotted-quad IPv4 or standard IPv6 address. Alternate encodings are refused rather than interpreted, because two readers can disagree about what they mean.`,
      };

    case 'loopback':
      return options.requirePrivateAddress && options.rejectLoopback === true
        ? {
            allowed: false,
            rejection: 'public_address',
            reason: `"${host}" is loopback, and this deployment requires the inference server to be a separate internal host.`,
          }
        : { allowed: true };

    case 'private':
      return { allowed: true };

    case 'public':
      return options.requirePrivateAddress
        ? {
            allowed: false,
            rejection: 'public_address',
            reason: `"${host}" is a public address. In production the inference server must be on your own network.`,
          }
        : { allowed: true };
  }
}

/* ------------------------------------------------------ classification */

/**
 * What class of address a literal is, or `null` if it is not a literal at all.
 *
 * **Alternate encodings are refused, not decoded.** `0177.0.0.1`, `0x7f.1`,
 * `2130706433` and `127.1` all reach 127.0.0.1 through `getaddrinfo`, and every
 * one of them is a documented way past a checker that only understands dotted
 * quads. Decoding them would mean reimplementing `inet_aton`'s quirks and
 * agreeing with the resolver about every edge; refusing them costs an operator
 * nothing, because nobody configures an inference server that way on purpose.
 */
export function classifyAddress(raw: string): AddressClass | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

  if (host.length === 0) {
    return null;
  }

  if (METADATA_ADDRESSES.includes(host)) {
    return 'metadata';
  }

  if (host.includes(':')) {
    return classifyIpv6(host);
  }

  // Anything made only of digits, dots, hex digits and an 0x prefix is an
  // address the resolver would interpret. If it is not a plain dotted quad, it
  // is one of the alternate encodings, and it is refused as such.
  if (/^(0x)?[0-9a-f.]+$/.test(host) && /[0-9]/.test(host)) {
    return classifyIpv4(host);
  }

  return null;
}

function classifyIpv4(host: string): AddressClass {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);

  if (!match) {
    // Digits and dots but not four plain octets: octal, hexadecimal, a bare
    // integer, or a short form. All of them resolve; none of them are accepted.
    return 'malformed';
  }

  const octets = match.slice(1, 5).map((part) => Number(part));

  if (octets.some((octet) => octet > 255)) {
    return 'malformed';
  }

  // A leading zero means the C resolver reads the octet as octal, so `010` is 8
  // to getaddrinfo and 10 to the regular expression above.
  if (match.slice(1, 5).some((part) => part.length > 1 && part.startsWith('0'))) {
    return 'malformed';
  }

  const [a = 0, b = 0, c = 0, d = 0] = octets;

  if (a === 0) return 'unspecified'; // 0.0.0.0/8 "this network"
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'broadcast';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved'; // 240.0.0.0/4, future use
  if (a === 192 && b === 0 && c === 0) return 'reserved'; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'reserved'; // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // benchmarking
  if (a === 198 && b === 51 && c === 100) return 'reserved'; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'reserved'; // TEST-NET-3
  if (a === 192 && b === 88 && c === 99) return 'reserved'; // 6to4 relay anycast

  return 'public';
}

function classifyIpv6(host: string): AddressClass {
  const address = host.split('%')[0] ?? ''; // drop any zone identifier

  if (!isIpv6Syntax(address)) {
    return 'malformed';
  }

  const expanded = expandIpv6(address);

  if (expanded === null) {
    return 'malformed';
  }

  // An IPv4-mapped or IPv4-compatible address is an IPv4 address wearing a
  // different notation, and `::ffff:169.254.169.254` reaches the metadata
  // service exactly as the dotted quad does. Classify what it actually is.
  const embedded = embeddedIpv4(expanded);

  if (embedded !== null) {
    return METADATA_ADDRESSES.includes(embedded) ? 'metadata' : classifyIpv4(embedded);
  }

  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0001') return 'loopback';
  if (expanded === '0000:0000:0000:0000:0000:0000:0000:0000') return 'unspecified';

  const first = expanded.slice(0, 4);
  const leading = Number.parseInt(first, 16);

  if ((leading & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  if ((leading & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10
  if ((leading & 0xffc0) === 0xfec0) return 'reserved'; // fec0::/10, deprecated site-local
  if ((leading & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 unique local
  if ((leading & 0xffff) === 0x2002) return 'reserved'; // 6to4, embeds an IPv4
  if (expanded.startsWith('0064:ff9b')) return 'reserved'; // NAT64, embeds an IPv4
  if (expanded.startsWith('0100:0000:0000:0000')) return 'reserved'; // discard-only
  if (expanded.startsWith('2001:0db8')) return 'reserved'; // documentation
  if (expanded.startsWith('2001:0000')) return 'reserved'; // Teredo, embeds an IPv4

  return 'public';
}

/** Strict enough that anything unusual is refused rather than guessed at. */
function isIpv6Syntax(address: string): boolean {
  if (!/^[0-9a-f:.]+$/.test(address)) {
    return false;
  }

  // At most one `::`, and never more than two colons in a row.
  const doubleColons = address.split('::').length - 1;

  return doubleColons <= 1 && !address.includes(':::');
}

/** Every group written out in full, so prefixes can be compared as text. */
function expandIpv6(address: string): string | null {
  let head = address;
  let tail = '';

  if (address.includes('::')) {
    const [before = '', after = ''] = address.split('::');
    head = before;
    tail = after;
  }

  const headGroups = head.length > 0 ? head.split(':') : [];
  const tailGroups = tail.length > 0 ? tail.split(':') : [];

  // A trailing dotted quad occupies two groups.
  const last = tailGroups.length > 0 ? tailGroups[tailGroups.length - 1] : headGroups.at(-1);
  let embedded: string[] = [];

  if (last?.includes('.')) {
    const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(last);

    if (!quad) {
      return null;
    }

    const octets = quad.slice(1, 5).map((part) => Number(part));

    if (octets.some((octet) => octet > 255)) {
      return null;
    }

    const [a = 0, b = 0, c = 0, d = 0] = octets;
    embedded = [
      ((a << 8) | b).toString(16).padStart(4, '0'),
      ((c << 8) | d).toString(16).padStart(4, '0'),
    ];

    if (tailGroups.length > 0) {
      tailGroups.pop();
    } else {
      headGroups.pop();
    }
  }

  const explicit = [...headGroups, ...tailGroups, ...embedded];

  if (explicit.some((group) => group.length === 0 || group.length > 4)) {
    return null;
  }

  const missing = 8 - explicit.length;

  if (address.includes('::')) {
    if (missing < 0) {
      return null;
    }
  } else if (missing !== 0) {
    return null;
  }

  const filler = Array.from({ length: Math.max(0, missing) }, () => '0000');
  const groups = [...headGroups.map(pad), ...filler, ...tailGroups.map(pad), ...embedded.map(pad)];

  return groups.length === 8 ? groups.join(':') : null;
}

function pad(group: string): string {
  return group.padStart(4, '0');
}

/** The dotted quad inside `::ffff:a.b.c.d` or `::a.b.c.d`, if there is one. */
function embeddedIpv4(expanded: string): string | null {
  const mapped = /^0000:0000:0000:0000:0000:ffff:([0-9a-f]{4}):([0-9a-f]{4})$/.exec(expanded);
  const compatible = /^0000:0000:0000:0000:0000:0000:([0-9a-f]{4}):([0-9a-f]{4})$/.exec(expanded);
  const match = mapped ?? compatible;

  if (!match) {
    return null;
  }

  const high = Number.parseInt(match[1] ?? '0', 16);
  const low = Number.parseInt(match[2] ?? '0', 16);

  // ::1 and :: are the loopback and unspecified addresses, not IPv4-compatible
  // ones; they are handled by their own cases.
  if (compatible && high === 0 && low <= 1) {
    return null;
  }

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/* ------------------------------------------------------------- helpers */

/**
 * Splits a URL into the parts this policy and the HTTP client care about.
 *
 * Hand-written because `@wdrg/contracts` is runtime-neutral by rule — no Node
 * APIs, no DOM APIs — and `URL` is neither guaranteed nor declared under the
 * package's ES2023-only lib. The parsing required is small and entirely
 * explicit, which is preferable to relaxing a constraint that exists so this
 * package can be bundled into a browser and loaded by a server unchanged.
 */
export function parseEndpoint(raw: string): ParsedEndpoint | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/i.exec(raw);

  if (!match) {
    return null;
  }

  const scheme = (match[1] ?? '').toLowerCase();
  const authority = match[2] ?? '';
  const path = match[3] ?? '';

  // An empty authority is reported with its scheme rather than as malformed, so
  // `file:///etc/passwd` gets the answer that explains it — "that scheme is not
  // supported" — instead of the one that does not.
  if (authority.length === 0) {
    return { scheme, host: '', port: null, path, hasCredentials: false };
  }

  const at = authority.lastIndexOf('@');
  const hasCredentials = at !== -1;
  const hostPort = hasCredentials ? authority.slice(at + 1) : authority;

  // Bracketed IPv6 keeps its colons; everything else splits on the port.
  const closing = hostPort.indexOf(']');
  const host = hostPort.startsWith('[')
    ? closing === -1
      ? hostPort
      : hostPort.slice(1, closing)
    : (hostPort.split(':')[0] ?? '');
  const portPart = hostPort.startsWith('[')
    ? hostPort.slice(closing + 1).replace(/^:/, '')
    : (hostPort.split(':')[1] ?? '');

  if (host.length === 0) {
    return null;
  }

  const port = portPart.length > 0 ? Number(portPart) : null;

  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    return null;
  }

  return {
    scheme,
    host: host.toLowerCase().replace(/\.$/, ''),
    port,
    path,
    hasCredentials,
  };
}

export interface ParsedEndpoint {
  readonly scheme: string;
  /** Lower-cased, without brackets around an IPv6 literal. */
  readonly host: string;
  readonly port: number | null;
  readonly path: string;
  readonly hasCredentials: boolean;
}

/** Suffix match on the registrable domain, so subdomains are covered. */
export function isHostedProvider(host: string): boolean {
  return matchesSuffix(host, HOSTED_INFERENCE_DOMAINS);
}

export function isLoopThroughService(host: string): boolean {
  return matchesSuffix(host, LOOP_THROUGH_DOMAINS);
}

export function isMetadataHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '');

  return METADATA_HOSTNAMES.includes(lower) || METADATA_ADDRESSES.includes(lower);
}

function matchesSuffix(host: string, domains: readonly string[]): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '');

  return domains.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

/**
 * Whether a *name* can only resolve inside a network.
 *
 * A single-label name (`vllm`, `ollama`) or a reserved private TLD cannot
 * resolve on the public internet, so it is accepted before resolution. Anything
 * else is a publicly-resolvable name whose addresses have to be checked.
 */
export function isInternalName(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '');

  if (isMetadataHost(lower)) {
    return false;
  }

  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    return true;
  }

  const labels = lower.split('.');

  if (labels.length === 1) {
    return true;
  }

  const tld = labels[labels.length - 1] ?? '';

  return ['internal', 'local', 'lan', 'home', 'intranet', 'private', 'corp'].includes(tld);
}

/**
 * Whether a host is on a private network, judged without resolving anything.
 *
 * Retained for callers that need a quick answer from a literal or a name — the
 * startup policy uses it. It is deliberately *not* the whole check: a name that
 * passes here still has its resolved addresses validated before a request is
 * made, because a name is a promise about the future, not a fact.
 */
export function isPrivateHost(host: string): boolean {
  const classified = classifyAddress(host);

  if (classified !== null) {
    return classified === 'private' || classified === 'loopback';
  }

  return isInternalName(host);
}
