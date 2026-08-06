import type { APIResponse, BrowserContext, Cookie } from '@playwright/test';
import { CSRF_COOKIE, CSRF_HEADER, PROJECT_SESSION_COOKIE } from '@wdrg/contracts';

import { API_URL, WEB_URL } from './environment';

/**
 * Server-side assertions that share the browser's cookie jar.
 *
 * `context.request` sends the same cookies the pages send, so a call made this
 * way is indistinguishable to the API from one the application made — which is
 * what makes it a fair way to check things the UI deliberately prevents, such as
 * submitting a deletion with the wrong confirmation name.
 */

export async function cookieByName(
  context: BrowserContext,
  name: string,
): Promise<Cookie | undefined> {
  const cookies = await context.cookies(API_URL);
  return cookies.find((cookie) => cookie.name === name);
}

export async function sessionCookie(context: BrowserContext): Promise<Cookie | undefined> {
  return cookieByName(context, PROJECT_SESSION_COOKIE);
}

export async function csrfToken(context: BrowserContext): Promise<string> {
  const cookie = await cookieByName(context, CSRF_COOKIE);

  if (!cookie) {
    throw new Error('No CSRF cookie: the context has no project session.');
  }

  return cookie.value;
}

/** A mutating API call carrying the session cookie, CSRF header and Origin. */
export async function mutate(
  context: BrowserContext,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
): Promise<APIResponse> {
  return context.request.fetch(`${API_URL}${path}`, {
    method,
    data: body,
    headers: {
      'content-type': 'application/json',
      origin: WEB_URL,
      [CSRF_HEADER]: await csrfToken(context),
    },
    failOnStatusCode: false,
  });
}

/** A read carrying whatever session the context holds. */
export async function read(context: BrowserContext, path: string): Promise<APIResponse> {
  return context.request.fetch(`${API_URL}${path}`, {
    headers: { origin: WEB_URL },
    failOnStatusCode: false,
  });
}
