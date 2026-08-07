import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  checkHost,
  checkInferenceEndpoint,
  checkResolvedAddresses,
  classifyAddress,
  parseEndpoint,
  type AddressClass,
  type EndpointPolicyOptions,
} from '@wdrg/contracts';

import type { AppConfigService } from '../../config/app-config.service';
import { EndpointGuard } from './endpoint-guard.service';
import { SafeHttpClient } from './safe-http.client';
import { OllamaProvider } from '../providers/ollama.provider';
import { OpenAiCompatibleProvider } from '../providers/openai-compatible.provider';
import { InferenceError } from '../providers/inference.types';

/**
 * The endpoint policy, treated as a security control rather than a setting.
 *
 * Requirement documents are a client's confidential material. An inference
 * request carries them out of the process, so *where that request goes* is the
 * single most consequential thing this application decides. The threat model is
 * not a careless operator — it is that every layer between "a URL in
 * configuration" and "bytes on a socket" can lie:
 *
 * - a hostname can resolve somewhere else than it did a moment ago;
 * - it can resolve to several addresses, only some of them acceptable;
 * - an address can be written in a form the checker and the resolver read
 *   differently;
 * - a server can answer with a redirect and choose the next destination itself.
 *
 * Each of those has tests below, and each is refused.
 */

const DEV: EndpointPolicyOptions = { requirePrivateAddress: false };
const PROD: EndpointPolicyOptions = { requirePrivateAddress: true };
const PROD_REMOTE: EndpointPolicyOptions = { requirePrivateAddress: true, rejectLoopback: true };

function config(overrides: Record<string, unknown> & { ai?: Record<string, unknown> } = {}) {
  const { ai, ...rest } = overrides;

  return {
    isProduction: false,
    ...rest,
    ai: {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      modelProfile: 'qwen2.5-3b-instruct',
      modelOverride: '',
      requestTimeoutMs: 5_000,
      runTimeoutMs: 60_000,
      maxContextTokens: 4_096,
      maxOutputTokens: 512,
      maxAttempts: 1,
      requireRemoteEndpoint: false,
      ...(ai ?? {}),
    },
  } as unknown as AppConfigService;
}

describe('address classification', () => {
  it.each<[string, AddressClass]>([
    /* Loopback and the private ranges: the addresses "self-hosted" means. */
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['::1', 'loopback'],
    ['10.0.0.5', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.10', 'private'],
    ['fd00::1', 'private'],
    ['fdab:cdef::42', 'private'],
    ['fc00::1', 'private'],

    /* Just outside them. A checker that gets these wrong is worse than none. */
    ['172.15.0.1', 'public'],
    ['172.32.0.1', 'public'],
    ['192.169.1.1', 'public'],
    ['11.0.0.1', 'public'],
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['2001:4860:4860::8888', 'public'],

    /* Never a legitimate inference server. */
    ['169.254.1.1', 'link_local'],
    ['fe80::1', 'link_local'],
    ['fe80::1%eth0', 'link_local'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['ff02::1', 'multicast'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
    ['100.64.0.1', 'shared'],
    ['100.127.255.255', 'shared'],
    ['192.0.2.1', 'reserved'],
    ['198.51.100.1', 'reserved'],
    ['203.0.113.1', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['2001:db8::1', 'reserved'],
    ['fec0::1', 'reserved'],
    ['2002:c0a8:0101::1', 'reserved'],
    ['64:ff9b::1.2.3.4', 'reserved'],

    /* Metadata, in every notation that reaches it. */
    ['169.254.169.254', 'metadata'],
    ['169.254.170.2', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['192.0.0.192', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['::ffff:169.254.169.254', 'metadata'],
  ])('classifies %s as %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it.each([
    /*
     * Every one of these reaches 127.0.0.1 through getaddrinfo, and every one
     * is a documented way past a checker that only understands dotted quads.
     * They are refused rather than decoded: agreeing with inet_aton about
     * every edge case is a losing game, and nobody configures an inference
     * server this way on purpose.
     */
    ['0177.0.0.1', 'octal'],
    ['0x7f.0.0.1', 'hexadecimal'],
    ['2130706433', 'a bare integer'],
    ['127.1', 'a short form'],
    ['127.0.1', 'a three-part form'],
    ['0x7f000001', 'a hexadecimal integer'],
    ['010.0.0.1', 'a leading zero'],
    ['1.2.3.4.5', 'five octets'],
    ['999.1.1.1', 'an out-of-range octet'],
    ['::ffff:0177.0.0.1', 'octal inside an IPv6 mapping'],
    ['1:2:3:4:5:6:7:8:9', 'nine IPv6 groups'],
    ['fe80:::1', 'a malformed IPv6 run'],
    ['12345::1', 'an oversized IPv6 group'],
  ])('refuses %s (%s) as malformed rather than interpreting it', (address) => {
    expect(classifyAddress(address)).toBe('malformed');
  });

  it('does not mistake a hostname for an address', () => {
    for (const host of ['ollama', 'vllm.internal', 'inference.example.com', 'gpu-box.lan']) {
      expect(classifyAddress(host)).toBeNull();
    }
  });

  it('reads an IPv4-mapped IPv6 address as the IPv4 address it is', () => {
    // ::ffff:10.0.0.1 and 10.0.0.1 are the same destination. A checker that
    // treats the first as "some IPv6 address" has a hole exactly the size of
    // the IPv4 internet.
    expect(classifyAddress('::ffff:10.0.0.1')).toBe('private');
    expect(classifyAddress('::ffff:8.8.8.8')).toBe('public');
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('loopback');
  });
});

describe('endpoint policy', () => {
  /* ------------------------------------------------- the fourteen cases */

  it('accepts a localhost development endpoint', () => {
    expect(checkInferenceEndpoint('http://127.0.0.1:11434', DEV).allowed).toBe(true);
    expect(checkInferenceEndpoint('http://localhost:11434', DEV).allowed).toBe(true);
    expect(checkInferenceEndpoint('http://[::1]:11434', DEV).allowed).toBe(true);
  });

  it('accepts a private IPv4 endpoint in production', () => {
    expect(checkInferenceEndpoint('http://10.0.4.20:8000', PROD).allowed).toBe(true);
    expect(checkInferenceEndpoint('http://192.168.1.50:8000', PROD).allowed).toBe(true);
    expect(checkInferenceEndpoint('http://172.16.9.9:8000', PROD).allowed).toBe(true);
  });

  it('accepts a permitted private IPv6 endpoint in production', () => {
    expect(checkInferenceEndpoint('http://[fd00::10]:8000', PROD).allowed).toBe(true);
    expect(checkInferenceEndpoint('http://[fdab:1234::5]:8000', PROD).allowed).toBe(true);
  });

  it('rejects a public IPv4 endpoint in production', () => {
    const verdict = checkInferenceEndpoint('http://93.184.216.34:8000', PROD);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('public_address');
  });

  it('rejects a public IPv6 endpoint in production', () => {
    const verdict = checkInferenceEndpoint('http://[2606:4700:4700::1111]:8000', PROD);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('public_address');
  });

  it('rejects loopback in production when the deployment requires a separate host', () => {
    // Off by default — a single-box deployment is legitimate — but a policy that
    // says inference lives on its own internal host can say so.
    expect(checkInferenceEndpoint('http://127.0.0.1:11434', PROD).allowed).toBe(true);

    const strict = checkInferenceEndpoint('http://127.0.0.1:11434', PROD_REMOTE);

    expect(strict.allowed).toBe(false);
    expect(strict.reason).toMatch(/separate internal host/i);

    // And it does not make private addresses collateral damage.
    expect(checkInferenceEndpoint('http://10.0.0.5:11434', PROD_REMOTE).allowed).toBe(true);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata/computeMetadata/v1/',
    'http://instance-data/latest/',
    'http://100.100.100.200/latest/meta-data/',
    'http://192.0.0.192/opc/v1/instance/',
    'http://169.254.170.2/v2/credentials/',
  ])('rejects the cloud metadata endpoint %s', (url) => {
    const verdict = checkInferenceEndpoint(url, DEV);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('metadata_endpoint');
  });

  it('rejects a metadata endpoint in development too', () => {
    // Not a production-only rule. There is no development scenario in which an
    // instance credential service is the inference server.
    expect(checkInferenceEndpoint('http://169.254.169.254', DEV).allowed).toBe(false);
    expect(checkInferenceEndpoint('http://metadata.google.internal', DEV).allowed).toBe(false);
  });

  it('rejects embedded credentials', () => {
    const verdict = checkInferenceEndpoint('http://user:hunter2pass@10.0.0.5:8000', DEV);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('credentials_in_url');
    // The rejection explains the rule without repeating the credential.
    expect(verdict.reason).not.toContain('hunter2pass');
  });

  it.each([
    'https://api.openai.com/v1',
    'https://api.anthropic.com',
    'https://generativelanguage.googleapis.com',
    'https://my-resource.openai.azure.com',
    'https://bedrock-runtime.us-east-1.amazonaws.com',
    'https://api.mistral.ai',
    'https://api.groq.com',
    'https://openrouter.ai/api/v1',
    'https://api-inference.huggingface.co',
    'https://api.together.xyz',
    'https://api.deepseek.com',
    'https://api.x.ai',
    'https://api.perplexity.ai',
  ])('rejects the hosted AI provider %s', (url) => {
    const verdict = checkInferenceEndpoint(url, DEV);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('hosted_provider');
  });

  it('rejects a hosted provider in development as firmly as in production', () => {
    // A developer must not be able to send a client's requirements to a vendor
    // either. This is the rule that makes "no requirement content leaves your
    // network" true rather than aspirational.
    expect(checkInferenceEndpoint('https://api.openai.com', DEV).allowed).toBe(false);
    expect(checkInferenceEndpoint('https://api.openai.com', PROD).allowed).toBe(false);
  });

  it.each([
    'http://10-0-0-5.nip.io:8000',
    'http://127.0.0.1.sslip.io:8000',
    'http://anything.xip.io',
    'http://abc123.ngrok.io',
    'http://tunnel.ngrok-free.app',
    'http://x.trycloudflare.com',
    'http://something.localhost.run',
    'http://app.loca.lt',
  ])('rejects the wildcard-DNS or tunnelling service %s', (url) => {
    const verdict = checkInferenceEndpoint(url, DEV);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('loop_through_service');
  });

  it('does not reject an internal host whose name merely resembles a vendor', () => {
    // The suffix match is on the registrable domain, so a perfectly reasonable
    // internal name for a self-hosted OpenAI-protocol server is not collateral.
    expect(checkInferenceEndpoint('http://openai.mycompany.internal:8000', PROD).allowed).toBe(
      true,
    );
    expect(checkInferenceEndpoint('http://ollama-proxy.internal:8000', PROD).allowed).toBe(true);
  });

  it.each([
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['gopher://10.0.0.5:70/', 'unsupported_scheme'],
    ['ftp://10.0.0.5/', 'unsupported_scheme'],
    ['not-a-url', 'malformed'],
    ['', 'not_configured'],
    ['   ', 'not_configured'],
  ])('rejects %s', (url, rejection) => {
    expect(checkInferenceEndpoint(url, DEV).rejection).toBe(rejection);
  });
});

describe('resolved addresses', () => {
  it('rejects a hostname that resolves to a public address', () => {
    const verdict = checkResolvedAddresses('inference.example.com', ['93.184.216.34'], PROD);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('public_address');
  });

  it('rejects a mixed public and private result rather than picking one', () => {
    /*
     * The dangerous case. A name returning both would succeed or fail depending
     * on resolver order, which is not a guarantee — so it is refused outright
     * rather than accepted on the strength of whichever came first.
     */
    const verdict = checkResolvedAddresses(
      'rebind.example.com',
      ['10.0.0.5', '93.184.216.34'],
      PROD,
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('mixed_addresses');
    expect(verdict.reason).toMatch(/depends on the resolver/i);
  });

  it('rejects the mixed case regardless of which address came first', () => {
    const publicFirst = checkResolvedAddresses(
      'r.example.com',
      ['93.184.216.34', '10.0.0.5'],
      PROD,
    );
    const privateFirst = checkResolvedAddresses(
      'r.example.com',
      ['10.0.0.5', '93.184.216.34'],
      PROD,
    );

    expect(publicFirst.allowed).toBe(false);
    expect(privateFirst.allowed).toBe(false);
  });

  it('rejects a hostname that resolves to a metadata address', () => {
    const verdict = checkResolvedAddresses('harmless.example.com', ['169.254.169.254'], DEV);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('metadata_endpoint');
  });

  it('rejects a hostname that resolves to link-local or unspecified', () => {
    expect(checkResolvedAddresses('a.example.com', ['169.254.10.1'], DEV).rejection).toBe(
      'link_local_address',
    );
    expect(checkResolvedAddresses('b.example.com', ['0.0.0.0'], DEV).rejection).toBe(
      'unspecified_address',
    );
  });

  it('rejects an empty resolution rather than treating it as nothing to object to', () => {
    const verdict = checkResolvedAddresses('nowhere.internal', [], DEV);

    expect(verdict.allowed).toBe(false);
    expect(verdict.rejection).toBe('no_addresses');
  });

  it('accepts a name that resolves entirely inside the network', () => {
    expect(checkResolvedAddresses('vllm.internal', ['10.0.0.5', '10.0.0.6'], PROD).allowed).toBe(
      true,
    );
    expect(checkResolvedAddresses('vllm.internal', ['fd00::5'], PROD).allowed).toBe(true);
  });

  it('never names the address it refused', () => {
    // A rejection reason gets logged. It should not become a map of the
    // internal network for whoever reads the log.
    const verdict = checkResolvedAddresses('host.example.com', ['10.1.2.3', '93.184.216.34'], PROD);

    expect(verdict.reason).not.toContain('10.1.2.3');
    expect(verdict.reason).not.toContain('93.184.216.34');
  });
});

describe('EndpointGuard', () => {
  it('resolves a literal address without consulting DNS', async () => {
    const guard = new EndpointGuard(config());
    const outcome = await guard.resolve('http://127.0.0.1:11434');

    expect(outcome.ok).toBe(true);

    if (outcome.ok) {
      expect(outcome.endpoint.address).toBe('127.0.0.1');
      expect(outcome.endpoint.port).toBe(11434);
      expect(outcome.endpoint.hostHeader).toBe('127.0.0.1:11434');
    }
  });

  it('resolves localhost and validates what it resolved to', async () => {
    const guard = new EndpointGuard(config());
    const outcome = await guard.resolve('http://localhost:11434');

    expect(outcome.ok).toBe(true);

    if (outcome.ok) {
      // Whatever the machine's resolver says localhost is, it must be loopback.
      expect(classifyAddress(outcome.endpoint.address)).toBe('loopback');
      // The Host header keeps the name, so virtual hosting still works.
      expect(outcome.endpoint.hostHeader).toBe('localhost:11434');
    }
  });

  it('refuses a name that does not resolve', async () => {
    const guard = new EndpointGuard(config());
    const outcome = await guard.resolve('http://no-such-host.invalid:8000');

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) {
      expect(outcome.verdict.rejection).toBe('no_addresses');
    }
  }, 15_000);

  it('applies the production policy when the deployment is production', async () => {
    const guard = new EndpointGuard(config({ isProduction: true }));
    const outcome = await guard.resolve('http://93.184.216.34:8000');

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) {
      expect(outcome.verdict.rejection).toBe('public_address');
    }
  });

  it('re-validates the connected peer', () => {
    const guard = new EndpointGuard(config({ isProduction: true }));

    expect(guard.checkConnectedPeer('vllm.internal', '10.0.0.5').allowed).toBe(true);
    // A peer that turned out to be somewhere else — what rebinding looks like
    // from the socket's point of view.
    expect(guard.checkConnectedPeer('vllm.internal', '93.184.216.34').allowed).toBe(false);
    expect(guard.checkConnectedPeer('vllm.internal', '169.254.169.254').rejection).toBe(
      'metadata_endpoint',
    );
    // Node reports an IPv4 peer on a dual-stack socket in mapped form.
    expect(guard.checkConnectedPeer('vllm.internal', '::ffff:169.254.169.254').allowed).toBe(false);
  });

  it('refuses every redirect, and says so more loudly for another host', () => {
    const guard = new EndpointGuard(config());
    const from = parseEndpoint('http://127.0.0.1:11434')!;

    const sameHost = guard.checkRedirectTarget('http://127.0.0.1:11434/elsewhere', from);
    const otherHost = guard.checkRedirectTarget('https://api.openai.com/v1/chat', from);
    const relative = guard.checkRedirectTarget('/somewhere-else', from);

    for (const verdict of [sameHost, otherHost, relative]) {
      expect(verdict.allowed).toBe(false);
      expect(verdict.rejection).toBe('redirect_refused');
    }

    expect(otherHost.reason).toMatch(/different host/i);
  });
});

describe('SafeHttpClient', () => {
  let server: Server;
  let port = 0;
  let redirectTo = 'https://api.openai.com/v1/chat/completions';
  let received: { host?: string; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];

      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          ...(request.headers.host === undefined ? {} : { host: request.headers.host }),
          body: Buffer.concat(chunks).toString('utf8'),
        });

        if (request.url?.startsWith('/redirect')) {
          response.writeHead(302, { location: redirectTo });
          response.end();

          return;
        }

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, url: request.url }));
      });
    });

    /*
     * Dual-stack, deliberately.
     *
     * `localhost` resolves to `::1` before `127.0.0.1` on some machines and the
     * other way round on others, and the guard connects to what the resolver
     * returned. Binding IPv4 only makes this suite pass locally and fail on a
     * runner — which it did. Binding both means the tests assert what they are
     * about (the Host header, the redirect policy) rather than the host's
     * resolver ordering.
     */
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received = [];
  });

  const client = (overrides: Record<string, unknown> = {}) =>
    new SafeHttpClient(new EndpointGuard(config(overrides)));

  it('sends a request to a permitted endpoint and reads the response', async () => {
    const response = await client().send({
      url: `http://127.0.0.1:${port}/api/chat`,
      method: 'POST',
      body: { model: 'test' },
      timeoutMs: 5_000,
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ ok: true, url: '/api/chat' });
    expect(received[0]?.body).toBe('{"model":"test"}');
  });

  it('sets the Host header from the configured name, not the pinned address', async () => {
    await client().send({
      url: `http://localhost:${port}/api/chat`,
      method: 'GET',
      timeoutMs: 5_000,
    });

    // The socket went to 127.0.0.1; the server still sees the name it is
    // configured under, so name-based virtual hosting keeps working.
    expect(received[0]?.host).toBe(`localhost:${port}`);
  });

  it.each([
    ['a hosted provider', 'https://api.openai.com/v1/chat/completions', /hosted inference/i],
    ['a metadata service', 'http://169.254.169.254/latest/meta-data/', /metadata/i],
    ['a wildcard DNS reflector', 'http://127.0.0.1.nip.io:8000/api', /wildcard-DNS|tunnelling/i],
    ['an endpoint with credentials', 'http://a:b@127.0.0.1:11434/api', /credentials/i],
    ['a link-local address', 'http://169.254.10.1:8000/api', /link-local/i],
    ['an alternate IP encoding', 'http://2130706433:8000/api', /Alternate encodings/i],
  ])('refuses to send to %s', async (_label, url, expected) => {
    await expect(client().send({ url, method: 'GET', timeoutMs: 2_000 })).rejects.toMatchObject({
      name: 'InferenceError',
      message: expect.stringMatching(expected),
    });

    // Nothing was sent anywhere. The refusal happens before the socket.
    expect(received).toHaveLength(0);
  });

  it('refuses a redirect to a hosted AI provider rather than following it', async () => {
    redirectTo = 'https://api.openai.com/v1/chat/completions';

    await expect(
      client().send({
        url: `http://127.0.0.1:${port}/redirect`,
        method: 'POST',
        body: { requirements: 'confidential client material' },
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      name: 'InferenceError',
      message: expect.stringMatching(/different host/i),
    });

    // The first request was made and refused at the response. Crucially there
    // is no second one: the redirect was not followed.
    expect(received).toHaveLength(1);
  });

  it('refuses a redirect to a public host rather than following it', async () => {
    redirectTo = 'http://93.184.216.34:8000/v1/chat';

    await expect(
      client().send({
        url: `http://127.0.0.1:${port}/redirect`,
        method: 'GET',
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ name: 'InferenceError' });

    expect(received).toHaveLength(1);
  });

  it('refuses a same-host redirect too', async () => {
    // Not because the destination is dangerous, but because a client that
    // follows redirects at all has handed destination choice to the server.
    redirectTo = `http://127.0.0.1:${port}/elsewhere`;

    await expect(
      client().send({ url: `http://127.0.0.1:${port}/redirect`, method: 'GET', timeoutMs: 5_000 }),
    ).rejects.toMatchObject({
      name: 'InferenceError',
      message: expect.stringMatching(/does not follow redirects/i),
    });

    expect(received).toHaveLength(1);
  });

  it('times out rather than waiting forever', async () => {
    const slow = createServer(() => {
      /* never responds */
    });

    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const slowPort = (slow.address() as AddressInfo).port;

    try {
      await expect(
        client().send({ url: `http://127.0.0.1:${slowPort}/api`, method: 'GET', timeoutMs: 300 }),
      ).rejects.toMatchObject({ name: 'InferenceError', reason: 'timeout' });
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()));
    }
  }, 15_000);
});

describe('both adapters enforce the same policy', () => {
  const hosted = { ai: { baseUrl: 'https://api.openai.com' } };
  const metadata = { ai: { baseUrl: 'http://169.254.169.254' } };

  const request = {
    messages: [{ role: 'user' as const, content: 'confidential requirement text' }],
    model: 'test-model',
    jsonMode: true,
    maxOutputTokens: 100,
    temperature: 0,
    timeoutMs: 2_000,
    correlationId: 'policy-parity',
    taskId: 'requirement.normalize' as const,
  };

  function adapters(overrides: Record<string, unknown> & { ai?: Record<string, unknown> }) {
    const settings = config(overrides);
    const http = new SafeHttpClient(new EndpointGuard(settings));

    return [
      new OllamaProvider(settings, http),
      new OpenAiCompatibleProvider(settings, http),
    ] as const;
  }

  it.each([
    ['a hosted provider', hosted],
    ['a metadata endpoint', metadata],
  ])('both refuse %s', async (_label, overrides) => {
    for (const provider of adapters(overrides)) {
      await expect(provider.complete(request)).rejects.toThrow(InferenceError);
    }
  });

  it('both report a refused endpoint through health rather than claiming reachability', async () => {
    const profile = {
      id: 'test',
      model: 'test-model',
      maxOutputTokens: 100,
    } as unknown as Parameters<OllamaProvider['health']>[0];

    for (const provider of adapters(hosted)) {
      const health = await provider.health(profile, 'test-model');

      expect(health.available).toBe(false);
      expect(health.detail).toMatch(/hosted inference provider/i);
    }
  });

  it('both re-check the endpoint on every request, not once at startup', async () => {
    // The configuration object is shared and mutated between calls, which is
    // what a runtime configuration change looks like from the adapter's side.
    const settings = config();
    const mutable = settings as unknown as { ai: { baseUrl: string } };
    const http = new SafeHttpClient(new EndpointGuard(settings));

    for (const provider of [
      new OllamaProvider(settings, http),
      new OpenAiCompatibleProvider(settings, http),
    ]) {
      mutable.ai.baseUrl = 'https://api.anthropic.com';

      await expect(provider.complete(request)).rejects.toThrow(InferenceError);
    }
  });
});

describe('checkHost', () => {
  it('applies the same rules a full URL would get', () => {
    expect(checkHost('api.openai.com', DEV).rejection).toBe('hosted_provider');
    expect(checkHost('169.254.169.254', DEV).rejection).toBe('metadata_endpoint');
    expect(checkHost('10.0.0.5', PROD).allowed).toBe(true);
    expect(checkHost('93.184.216.34', PROD).rejection).toBe('public_address');
    expect(checkHost('93.184.216.34', DEV).allowed).toBe(true);
  });
});
