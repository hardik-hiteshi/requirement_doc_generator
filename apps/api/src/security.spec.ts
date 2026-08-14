import { Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import type { AppConfigService } from './config';
import { buildHelmetOptions, configureSecurity } from './security';

@Controller('probe')
class ProbeController {
  @Get()
  get(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Only the fields `configureSecurity` reads. Using a stub rather than booting
 * the full application keeps these assertions in the unit suite — they need no
 * database — and makes the environment explicit instead of depending on when
 * `ConfigModule.forRoot()` happens to snapshot `process.env`.
 */
function stubConfig(overrides: { isProduction: boolean }): AppConfigService {
  return {
    isProduction: overrides.isProduction,
    security: {
      allowedOrigins: ['http://localhost:3000'],
      bodyLimitBytes: 1024,
    },
    // Cast through `unknown`: this is deliberately a partial stub of the
    // service, carrying only what configureSecurity reads.
  } as unknown as AppConfigService;
}

async function createApp(isProduction: boolean): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
  // The oversized-body case makes Nest log a handled PayloadTooLargeError. A
  // passing suite that prints ERROR lines teaches people to ignore them.
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });

  configureSecurity(app, stubConfig({ isProduction }));

  await app.init();
  return app;
}

describe('buildHelmetOptions', () => {
  it('leaves helmet defaults in place in production, so the CSP header is sent', () => {
    // `undefined` means "use helmet's default policy"; `false` means "omit".
    expect(
      buildHelmetOptions(stubConfig({ isProduction: true })).contentSecurityPolicy,
    ).toBeUndefined();
  });

  it('disables the CSP outside production, so the Swagger UI is usable', () => {
    expect(buildHelmetOptions(stubConfig({ isProduction: false })).contentSecurityPolicy).toBe(
      false,
    );
  });

  it('restricts cross-origin resource sharing of responses in both environments', () => {
    for (const isProduction of [true, false]) {
      expect(buildHelmetOptions(stubConfig({ isProduction })).crossOriginResourcePolicy).toEqual({
        policy: 'same-site',
      });
    }
  });
});

describe('configureSecurity — production', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp(true);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('sends a Content-Security-Policy', async () => {
    const response = await request(app.getHttpServer()).get('/probe').expect(200);
    const csp = response.headers['content-security-policy'];

    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
  });

  it('sends the transport hardening headers', async () => {
    const response = await request(app.getHttpServer()).get('/probe').expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['strict-transport-security']).toContain('max-age=');
  });

  it('does not advertise the server implementation', async () => {
    const response = await request(app.getHttpServer()).get('/probe');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('still sends security headers on an error response', async () => {
    const response = await request(app.getHttpServer()).get('/no-such-route').expect(404);

    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('exposes the correlation id header so a browser client can read it', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe')
      .set('Origin', 'http://localhost:3000');

    expect(response.headers['access-control-expose-headers']).toContain('x-correlation-id');
  });

  /*
   * Without this a download saves as "document" plus a guessed extension: the browser
   * hides Content-Disposition from cross-origin script unless it is exposed, so the
   * project, version and lifecycle the server put in the filename never arrive.
   */
  it('exposes the filename header so a download keeps the name the server chose', async () => {
    const response = await request(app.getHttpServer())
      .get('/probe')
      .set('Origin', 'http://localhost:3000');

    expect(response.headers['access-control-expose-headers']).toContain('Content-Disposition');
  });

  it('allows a configured origin and does not reflect an unknown one', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/probe')
      .set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');

    const rejected = await request(app.getHttpServer())
      .get('/probe')
      .set('Origin', 'https://attacker.example');
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a body larger than the configured limit', async () => {
    const response = await request(app.getHttpServer())
      .post('/probe')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(4096) }));

    expect(response.status).toBe(413);
  });
});

describe('configureSecurity — non-production', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp(false);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('omits the Content-Security-Policy', async () => {
    const response = await request(app.getHttpServer()).get('/probe').expect(200);

    expect(response.headers['content-security-policy']).toBeUndefined();
  });

  it('still sends the other hardening headers', async () => {
    const response = await request(app.getHttpServer()).get('/probe').expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
  });
});
