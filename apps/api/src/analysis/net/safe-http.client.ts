import { Injectable, Logger } from '@nestjs/common';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';

import { EndpointGuard, type ResolvedEndpoint } from './endpoint-guard.service';
import { InferenceError } from '../providers/inference.types';

/**
 * The only way an inference adapter reaches the network.
 *
 * `fetch` is not used here, and the reason is specific rather than
 * ideological. Three things this needs cannot be expressed through it:
 *
 * 1. **Connect to a validated address, not to a name.** The socket is opened to
 *    the address the guard checked. No resolution happens at connection time,
 *    so there is no second DNS answer for an attacker to substitute — which is
 *    what a DNS rebinding attack is. `fetch` resolves the name itself, after
 *    any check the caller performed.
 * 2. **Nothing is sent until the peer is confirmed.** The request body — a
 *    client's confidential requirements — is written only after the socket has
 *    connected and the peer address has been validated again.
 * 3. **Redirects fail rather than being followed.** `redirect: 'manual'` gets
 *    close, but `node:http` does not follow them at all, which is a stronger
 *    statement than asking a library not to.
 *
 * Both inference adapters use this, so the policy cannot apply to one and not
 * the other.
 */

export interface SafeRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly correlationId?: string;
}

export interface SafeResponse {
  readonly status: number;
  readonly body: string;
  readonly peerAddress: string | null;
}

@Injectable()
export class SafeHttpClient {
  private readonly logger = new Logger(SafeHttpClient.name);

  constructor(private readonly guard: EndpointGuard) {}

  async send(request: SafeRequest): Promise<SafeResponse> {
    const outcome = await this.guard.resolve(request.url);

    if (!outcome.ok) {
      throw new InferenceError(
        'provider_unavailable',
        outcome.verdict.reason ?? 'The configured inference endpoint is not permitted.',
      );
    }

    return this.dispatch(outcome.endpoint, request);
  }

  private dispatch(endpoint: ResolvedEndpoint, request: SafeRequest): Promise<SafeResponse> {
    const secure = endpoint.parsed.scheme === 'https';
    const payload = request.body === undefined ? null : JSON.stringify(request.body);

    return new Promise<SafeResponse>((resolve, reject) => {
      let settled = false;

      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clientRequest.destroy();
        reject(error);
      };

      const succeed = (response: SafeResponse): void => {
        if (settled) return;
        settled = true;
        resolve(response);
      };

      const clientRequest: ClientRequest = (secure ? httpsRequest : httpRequest)({
        // The pinned address. Not the hostname — that is what the Host header
        // and the TLS server name are for.
        hostname: endpoint.address,
        port: endpoint.port,
        family: endpoint.family,
        path: endpoint.parsed.path.length > 0 ? endpoint.parsed.path : '/',
        method: request.method,
        // A fresh socket every time. A pooled one could have been opened to an
        // address that was permitted when the pool was warm and is not now.
        agent: false,
        headers: {
          host: endpoint.hostHeader,
          accept: 'application/json',
          ...(payload === null
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              }),
        },
        ...(secure ? { servername: endpoint.parsed.host } : {}),
      });

      clientRequest.setTimeout(request.timeoutMs, () => {
        fail(new InferenceError('timeout', 'The inference request timed out.'));
      });

      clientRequest.on('error', (cause: Error) => {
        if (cause instanceof InferenceError) {
          fail(cause);

          return;
        }

        this.logger.error(
          { correlationId: request.correlationId, host: endpoint.parsed.host },
          'Inference request failed at the transport',
        );

        fail(
          new InferenceError('provider_unavailable', 'The inference server could not be reached.', {
            cause,
          }),
        );
      });

      clientRequest.on('socket', (socket: Socket) => {
        const onConnected = (): void => {
          const peer = socket.remoteAddress ?? null;

          /*
           * The peer, checked against the same policy, before a single byte of
           * requirement content is written. This should always agree with the
           * pinned address — and the day it does not is the day this check is
           * the only thing standing between a client's requirements and
           * somewhere they must not go.
           */
          if (peer !== null) {
            const verdict = this.guard.checkConnectedPeer(endpoint.parsed.host, peer);

            if (!verdict.allowed) {
              this.logger.error(
                { host: endpoint.parsed.host, rejection: verdict.rejection },
                'Refused a connected peer after the socket opened',
              );

              fail(
                new InferenceError(
                  'provider_unavailable',
                  verdict.reason ?? 'The connection reached an address that is not permitted.',
                ),
              );

              return;
            }
          }

          if (payload !== null) {
            clientRequest.write(payload);
          }

          clientRequest.end();
        };

        if (socket.connecting) {
          socket.once(secure ? 'secureConnect' : 'connect', onConnected);
        } else {
          onConnected();
        }
      });

      clientRequest.on('response', (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;

        /*
         * A redirect is refused, never followed — and the refusal happens here,
         * before the body is read, so nothing about the response is acted on.
         *
         * Following one would hand the choice of destination to whoever
         * controls the server, which is precisely the reverse of the property
         * this whole module exists to provide.
         */
        if (status >= 300 && status < 400) {
          const location = headerValue(response, 'location');
          const verdict = this.guard.checkRedirectTarget(location ?? '', endpoint.parsed);

          response.resume(); // drain, so the socket can close cleanly

          this.logger.warn(
            { host: endpoint.parsed.host, status, correlationId: request.correlationId },
            'Refused to follow a redirect from the inference server',
          );

          fail(
            new InferenceError(
              'provider_unavailable',
              verdict.reason ?? 'The inference server redirected, which this client refuses.',
            ),
          );

          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;

        response.on('data', (chunk: Buffer) => {
          size += chunk.length;

          // A model server that streams unbounded output would otherwise be a
          // memory exhaustion primitive. The ceiling is far above any real
          // structured response.
          if (size > MAX_RESPONSE_BYTES) {
            fail(
              new InferenceError(
                'partial_response',
                'The inference server returned more data than this client will read.',
              ),
            );

            return;
          }

          chunks.push(chunk);
        });

        response.on('end', () => {
          succeed({
            status,
            body: Buffer.concat(chunks).toString('utf8'),
            peerAddress: response.socket?.remoteAddress ?? null,
          });
        });

        response.on('error', (cause: Error) => {
          fail(
            new InferenceError('provider_unavailable', 'The inference response failed.', { cause }),
          );
        });
      });
    });
  }
}

/** 64 MB. Orders of magnitude above any schema-validated task result. */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function headerValue(response: IncomingMessage, name: string): string | null {
  const raw = response.headers[name];

  if (Array.isArray(raw)) {
    return raw[0] ?? null;
  }

  return raw ?? null;
}
