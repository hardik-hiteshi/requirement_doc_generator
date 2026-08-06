import { readFile } from 'node:fs/promises';

import { expect, type Page } from '@playwright/test';
import { PROJECT_ROUTES } from '@wdrg/contracts';

import { API_LOG_PATH, API_PRODUCTION_LOG_PATH, WEB_LOG_PATH } from './environment';

/**
 * Watching for the one value that must not escape.
 *
 * A recovery secret is a bearer credential. There is exactly one place it is
 * allowed to travel over the wire — the body of the exchange request, which is
 * the whole point of the exchange — and exactly one place it is allowed to be
 * stored, which is the user's own copy of the link. Everywhere else, its
 * appearance is a defect: a URL is written to access logs and `Referer` headers,
 * a request header is often mirrored into telemetry, and an application log is
 * routinely shipped to a third party.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

export interface RequestRecorder {
  readonly requests: readonly RecordedRequest[];
}

/** Records every request the page makes, for the lifetime of the page. */
export function recordRequests(page: Page): RequestRecorder {
  const requests: RecordedRequest[] = [];

  page.on('request', (request) => {
    requests.push({
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      body: request.postData(),
    });
  });

  return { requests };
}

/** The API and web server output produced so far. */
export async function readApplicationLogs(): Promise<string> {
  const contents = await Promise.all(
    [API_LOG_PATH, API_PRODUCTION_LOG_PATH, WEB_LOG_PATH].map((path) => readFile(path, 'utf8')),
  );

  return contents.join('\n');
}

/**
 * Asserts a secret appears only where the design says it may.
 *
 * The exchange request is the single allowed carrier, and only in its body — so
 * that endpoint is named explicitly here rather than left as a general "ignore
 * POST bodies" exemption that would hide a leak somewhere else.
 */
export async function expectSecretConfined(
  secret: string,
  recorder: RequestRecorder,
  page: Page,
): Promise<void> {
  const url = new URL(page.url());

  expect(url.pathname, 'the secret must never reach the URL path').not.toContain(secret);
  expect(url.search, 'the secret must never reach a query parameter').not.toContain(secret);

  for (const request of recorder.requests) {
    expect(
      request.url,
      `request URL leaked the secret: ${request.method} ${request.url}`,
    ).not.toContain(secret);

    for (const [name, value] of Object.entries(request.headers)) {
      expect(value, `request header "${name}" leaked the secret`).not.toContain(secret);
    }

    if (request.body?.includes(secret)) {
      const path = new URL(request.url).pathname;

      expect(
        path,
        `only the recovery exchange may carry the secret; ${request.method} ${path} did`,
      ).toBe(PROJECT_ROUTES.exchange);
      expect(request.method).toBe('POST');
    }
  }

  const logs = await readApplicationLogs();
  expect(logs, 'the secret must never be written to an application log').not.toContain(secret);
}
