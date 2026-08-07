import { Injectable, Logger } from '@nestjs/common';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  checkHost,
  checkInferenceEndpoint,
  checkResolvedAddresses,
  classifyAddress,
  parseEndpoint,
  type EndpointPolicyOptions,
  type EndpointVerdict,
  type ParsedEndpoint,
} from '@wdrg/contracts';

import { AppConfigService } from '../../config/app-config.service';

/**
 * Decides where an inference request is allowed to go, and pins it there.
 *
 * The contracts package classifies addresses; this resolves names. Splitting
 * them that way keeps the rules pure and testable while the part that touches
 * the network stays in one place, with one entry point.
 *
 * **The threat is not a careless operator.** It is that a hostname is a promise
 * about the future, and DNS can break it. A name that resolved to `10.0.0.5`
 * when the application started can resolve to `169.254.169.254` a second later,
 * or resolve to the private address for the *check* and a public one for the
 * *connection* a millisecond afterwards — DNS rebinding, and a TTL of zero is
 * all it takes. So:
 *
 * - Resolution happens per request, not once at startup.
 * - **Every** returned address is validated, not the first one.
 * - The validated address is what gets connected to. The socket never repeats
 *   the lookup, so there is no second answer for an attacker to control.
 *
 * Nothing here needs a paid service. `node:dns` and `node:http` do all of it.
 */
export interface ResolvedEndpoint {
  readonly parsed: ParsedEndpoint;
  /** The single address the socket must connect to. Already validated. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: number;
  /** What the `Host` header must say, so virtual hosting still works. */
  readonly hostHeader: string;
}

export type GuardOutcome =
  | { readonly ok: true; readonly endpoint: ResolvedEndpoint }
  | { readonly ok: false; readonly verdict: EndpointVerdict };

@Injectable()
export class EndpointGuard {
  private readonly logger = new Logger(EndpointGuard.name);

  constructor(private readonly config: AppConfigService) {}

  /** The policy this deployment applies, derived from its configuration. */
  get policy(): EndpointPolicyOptions {
    return {
      requirePrivateAddress: this.config.isProduction,
      rejectLoopback: this.config.ai.requireRemoteEndpoint,
    };
  }

  /**
   * Validates a URL and resolves it to one address that may be connected to.
   *
   * Called on **every** request. Startup validation proves the configuration
   * was sane when the process began, which is a different claim from "this
   * request is going somewhere permitted".
   */
  async resolve(rawUrl: string): Promise<GuardOutcome> {
    const verdict = checkInferenceEndpoint(rawUrl, this.policy);

    if (!verdict.allowed) {
      return { ok: false, verdict };
    }

    const parsed = parseEndpoint(rawUrl);

    if (!parsed) {
      return {
        ok: false,
        verdict: { allowed: false, rejection: 'malformed', reason: 'The endpoint is not a URL.' },
      };
    }

    const port = parsed.port ?? (parsed.scheme === 'https' ? 443 : 80);
    const literal = classifyAddress(parsed.host);

    // Already an address: nothing to resolve, and checkInferenceEndpoint has
    // classified it. Connect straight to it.
    if (literal !== null) {
      return {
        ok: true,
        endpoint: {
          parsed,
          address: parsed.host,
          family: parsed.host.includes(':') ? 6 : 4,
          port,
          hostHeader: formatHostHeader(parsed.host, parsed.port),
        },
      };
    }

    const addresses = await this.lookupAll(parsed.host);

    if (addresses === null) {
      return {
        ok: false,
        verdict: {
          allowed: false,
          rejection: 'no_addresses',
          reason: `"${parsed.host}" could not be resolved.`,
        },
      };
    }

    const resolved = checkResolvedAddresses(
      parsed.host,
      addresses.map((entry) => entry.address),
      this.policy,
    );

    if (!resolved.allowed) {
      this.logger.warn(
        { host: parsed.host, rejection: resolved.rejection, count: addresses.length },
        'Refused an inference endpoint by its resolved addresses',
      );

      return { ok: false, verdict: resolved };
    }

    const chosen = addresses[0];

    if (!chosen) {
      return {
        ok: false,
        verdict: {
          allowed: false,
          rejection: 'no_addresses',
          reason: `"${parsed.host}" did not resolve to any address.`,
        },
      };
    }

    return {
      ok: true,
      endpoint: {
        parsed,
        address: chosen.address,
        family: chosen.family === 6 ? 6 : 4,
        port,
        hostHeader: formatHostHeader(parsed.host, parsed.port),
      },
    };
  }

  /**
   * Re-checks an address at the moment of connection.
   *
   * The last line against rebinding, and against a resolver that answered
   * differently between the check and the socket. It should never fire — the
   * connection is made to a pinned address — which is exactly why it is worth
   * having: if it ever does, something changed the destination underneath.
   */
  checkConnectedPeer(host: string, address: string): EndpointVerdict {
    const classified = classifyAddress(address);

    if (classified === null) {
      return {
        allowed: false,
        rejection: 'malformed_address',
        reason: 'The connection peer address could not be classified.',
      };
    }

    return checkHost(address, this.policy);
  }

  /** Applies the same rules to a redirect target as to the configured URL. */
  checkRedirectTarget(location: string, from: ParsedEndpoint): EndpointVerdict {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(location);

    if (!absolute) {
      // A relative redirect stays on the host already validated. Still refused,
      // because the adapters address specific endpoints and a server moving one
      // means the configuration is wrong, but refused with an honest reason.
      return {
        allowed: false,
        rejection: 'redirect_refused',
        reason: 'The inference server redirected. This client does not follow redirects.',
      };
    }

    const target = parseEndpoint(location);

    if (!target) {
      return {
        allowed: false,
        rejection: 'redirect_refused',
        reason: 'The inference server redirected to a location that is not a valid URL.',
      };
    }

    const sameHost = target.host === from.host && target.scheme === from.scheme;

    return {
      allowed: false,
      rejection: 'redirect_refused',
      reason: sameHost
        ? 'The inference server redirected. This client does not follow redirects.'
        : `The inference server redirected to "${target.host}", a different host. Requirement content is not sent to a destination chosen by a redirect.`,
    };
  }

  private async lookupAll(host: string): Promise<{ address: string; family: number }[] | null> {
    try {
      // `all` because one answer is not the answer: a name with a private and a
      // public address must be refused, and asking for one hides that.
      // `verbatim` so the resolver's order is preserved rather than reordered
      // by a heuristic that could differ from what gets checked.
      return await dnsLookup(host, { all: true, verbatim: true });
    } catch {
      return null;
    }
  }
}

function formatHostHeader(host: string, port: number | null): string {
  const bracketed = host.includes(':') ? `[${host}]` : host;

  return port === null ? bracketed : `${bracketed}:${port}`;
}
