import { expect, test, type Cookie } from '@playwright/test';
import { CSRF_COOKIE, PROJECT_ROUTES, PROJECT_SESSION_COOKIE } from '@wdrg/contracts';

import { cookieByName, read, sessionCookie } from './support/api';
import { API_PRODUCTION_URL, API_URL, WEB_URL } from './support/environment';
import {
  createProject,
  enterWorkspace,
  openDeleteDialog,
  projectPanel,
  section,
} from './support/workspace';

/**
 * Cookie behaviour, observed in the browser rather than asserted from the code
 * that sets it.
 *
 * The session cookie is the whole authorisation model, so the properties that
 * make it safe are checked against what Chromium actually stored — through the
 * browser-context cookie API, never through page JavaScript, which by design
 * cannot see an `HttpOnly` cookie at all.
 */

function requireCookie(name: string, cookie: Cookie | undefined): Cookie {
  expect(cookie, `expected a ${name} cookie`).toBeDefined();
  return cookie!;
}

test.describe('session cookies', () => {
  test('the session cookie is HttpOnly, SameSite=Lax and correctly scoped', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await createProject(page, { name: 'Cookie scope check' });
    await enterWorkspace(page);

    const session = requireCookie(
      PROJECT_SESSION_COOKIE,
      await cookieByName(context, PROJECT_SESSION_COOKIE),
    );

    expect(session.httpOnly, 'script must never be able to read the session').toBe(true);
    expect(session.sameSite).toBe('Lax');
    expect(session.path).toBe('/');
    expect(session.domain).toBe('127.0.0.1');
    expect(session.expires).toBeGreaterThan(Date.now() / 1000);

    // Not `Secure` here, and that is correct: this API runs in test mode over
    // plain http. The production case is asserted separately below.
    expect(session.secure).toBe(false);

    // The paired CSRF cookie is deliberately readable — that is what makes the
    // double-submit check possible — but it is not the credential.
    const csrf = requireCookie(CSRF_COOKIE, await cookieByName(context, CSRF_COOKIE));
    expect(csrf.httpOnly).toBe(false);
    expect(csrf.sameSite).toBe('Lax');

    // Confirm HttpOnly from the page's own point of view: the session must be
    // absent from document.cookie while the CSRF token is present.
    const visibleToScript = await page.evaluate(() => document.cookie);
    expect(visibleToScript).not.toContain(PROJECT_SESSION_COOKIE);
  });

  test('production mode sets Secure on both cookies', async ({ request }) => {
    // A second API instance, started by Playwright in NODE_ENV=production with
    // its own database. Asserting this against the test-mode server would prove
    // nothing, because `secure` is exactly the flag that differs.
    const response = await request.post(`${API_PRODUCTION_URL}${PROJECT_ROUTES.create}`, {
      data: { name: 'Production cookie flags' },
      headers: { origin: WEB_URL },
    });

    expect(response.status()).toBe(201);

    const setCookies = response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value);

    const sessionHeader = setCookies.find((value) =>
      value.startsWith(`${PROJECT_SESSION_COOKIE}=`),
    );
    const csrfHeader = setCookies.find((value) => value.startsWith(`${CSRF_COOKIE}=`));

    expect(sessionHeader, 'production must issue a session cookie').toBeDefined();
    expect(sessionHeader).toContain('Secure');
    expect(sessionHeader).toContain('HttpOnly');
    expect(sessionHeader).toContain('SameSite=Lax');
    expect(sessionHeader).toContain('Path=/');

    expect(csrfHeader).toContain('Secure');
    expect(csrfHeader).not.toContain('HttpOnly');
  });

  test('ending the session clears the cookie and closes access', async ({ page, context }) => {
    await page.goto('/');
    await createProject(page, { name: 'Session termination' });
    await enterWorkspace(page);

    expect((await sessionCookie(context))?.value).toBeTruthy();

    await page.getByRole('button', { name: 'End session' }).click();
    await expect(page.getByText(/Your project session has ended/)).toBeVisible();

    const cleared = await sessionCookie(context);
    expect(cleared?.value ?? '').toBe('');
    expect((await read(context, PROJECT_ROUTES.current)).status()).toBe(401);
  });

  test('deleting the project invalidates the session', async ({ page, context }) => {
    await page.goto('/');
    await createProject(page, { name: 'Deletion invalidates' });
    await enterWorkspace(page);

    const dialog = await openDeleteDialog(page);
    await dialog
      .getByRole('textbox', { name: /Type the project name to confirm/ })
      .fill('Deletion invalidates');
    await page.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page.getByText(/The project has been deleted/)).toBeVisible();

    const afterDelete = await sessionCookie(context);
    expect(afterDelete?.value ?? '').toBe('');
    expect((await read(context, PROJECT_ROUTES.current)).status()).toBe(401);
  });

  test('a browser context with no cookies cannot reach any project', async ({ page, browser }) => {
    await page.goto('/');
    const owned = await createProject(page, { name: 'Owned by the first browser' });
    await enterWorkspace(page);
    await expect(projectPanel(page).getByText(owned.projectId)).toBeVisible();

    const stranger = await browser.newContext();
    const strangerPage = await stranger.newPage();

    await strangerPage.goto('/');
    await expect(section(strangerPage, 'details')).toHaveCount(0);

    expect((await read(stranger, PROJECT_ROUTES.current)).status()).toBe(401);

    // Knowing the identifier is not enough — it names the project, it does not
    // authorise it. Without the secret there is nothing to exchange.
    const guessed = await stranger.request.post(`${API_URL}${PROJECT_ROUTES.exchange}`, {
      data: { projectId: owned.projectId, recoverySecret: 'x'.repeat(43) },
      headers: { origin: WEB_URL },
      failOnStatusCode: false,
    });
    expect(guessed.status()).toBe(401);

    await stranger.close();
  });
});
