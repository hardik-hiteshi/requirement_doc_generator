import { expect, test } from '@playwright/test';
import {
  PROJECT_ACCESS_DENIED_MESSAGE,
  PROJECT_ID_PATTERN,
  PROJECT_ROUTES,
  PROJECT_SESSION_COOKIE,
} from '@wdrg/contracts';

import { mutate, read, sessionCookie } from './support/api';
import { expireProject, readAuditEventTypes, readProjectDocument } from './support/database';
import { expectSecretConfined, recordRequests } from './support/leakage';
import {
  configureEverySection,
  createPanel,
  createProject,
  CONFIGURED,
  enterWorkspace,
  expectConfiguredStateVisible,
  openDeleteDialog,
  projectPanel,
  section,
} from './support/workspace';

/**
 * The Phase 2 workflow, driven through a real browser.
 *
 * The API integration suite already proves each endpoint in isolation. What only
 * a browser can prove is everything between them: that the cookie jar carries a
 * session across a reload, that the URL fragment never reaches the server, that
 * `history.replaceState` actually removes the secret from the address bar, and
 * that a second browser with no cookies can walk in with nothing but the link.
 */

const MONGO_OBJECT_ID = /^[0-9a-f]{24}$/i;

test.describe('anonymous project lifecycle', () => {
  test('create, configure, leave, recover, delete', async ({ page, browser }) => {
    const recorder = recordRequests(page);

    /* 1. A clean browser opens the public application. */
    await page.goto('/');
    await expect(createPanel(page)).toBeVisible();

    /* 2. Create an anonymous project. */
    const created = await createProject(page, {
      name: 'Northwind quoting platform',
      clientName: CONFIGURED.clientName,
    });

    /* 3. The public identifier is not the database's. */
    expect(created.projectId).toMatch(PROJECT_ID_PATTERN);
    expect(created.projectId).not.toMatch(MONGO_OBJECT_ID);
    expect(created.projectId.replace(/^prj_/, '')).not.toMatch(MONGO_OBJECT_ID);

    const stored = await readProjectDocument(created.projectId);
    expect(stored, 'the project should exist in the isolated test database').not.toBeNull();
    expect(String(stored?._id)).not.toBe(created.projectId);

    /* 4. The secret is in the fragment, and only in the fragment. */
    const [beforeHash, fragment] = created.recoveryLink.split('#');
    expect(beforeHash).not.toContain(created.recoverySecret);
    expect(fragment).toContain(created.recoverySecret);

    /* 5. It has not leaked into the URL, the network or the logs. */
    await expectSecretConfined(created.recoverySecret, recorder, page);

    /* 6. Enter the workspace on the session creation issued. */
    await enterWorkspace(page);
    await expect(projectPanel(page).getByText(created.projectId)).toBeVisible();

    /* 7. Configure every section. */
    await configureEverySection(page);

    /* 8. Each section shows what it saved. */
    await expectConfiguredStateVisible(page);

    /* 9. A refresh restores the session and the saved state. */
    await page.reload();
    await expect(section(page, 'details')).toBeVisible();
    await expectConfiguredStateVisible(page);

    /* 10. A second browser context, with no cookies at all. */
    const returning = await browser.newContext();
    const returningPage = await returning.newPage();
    const returningRecorder = recordRequests(returningPage);

    await returningPage.goto('/');
    await expect(createPanel(returningPage)).toBeVisible();
    expect(await sessionCookie(returning)).toBeUndefined();

    /* 11. Open the private recovery link. */
    await returningPage.goto(created.recoveryLink);

    /* 12 & 13. The fragment is read, exchanged, and removed from the address bar. */
    await expect(section(returningPage, 'details')).toBeVisible();
    expect(returningPage.url()).toBe(`${new URL(created.recoveryLink).origin}/`);
    expect(await returningPage.evaluate(() => window.location.hash)).toBe('');
    expect(returningPage.url()).not.toContain(created.recoverySecret);

    // The secret is gone from session history too — `replaceState` overwrote the
    // entry rather than pushing a new one, so there is nothing to go back to
    // that still contains it.
    await returningPage.goBack().catch(() => null);
    expect(returningPage.url()).not.toContain(created.recoverySecret);
    await expectSecretConfined(created.recoverySecret, returningRecorder, returningPage);

    /* 14. The recovered project is the one that was saved. */
    if (returningPage.url() !== `${new URL(created.recoveryLink).origin}/`) {
      await returningPage.goto('/');
    }
    await expect(section(returningPage, 'details')).toBeVisible();
    await expectConfiguredStateVisible(returningPage);
    await expect(projectPanel(returningPage).getByText(created.projectId)).toBeVisible();

    /* 15. End the project session. */
    await returningPage.getByRole('button', { name: 'End session' }).click();
    await expect(returningPage.getByText(/Your project session has ended/)).toBeVisible();

    /* 16. Protected access is gone. */
    const cleared = await sessionCookie(returning);
    expect(cleared?.value ?? '').toBe('');

    await returningPage.reload();
    await expect(createPanel(returningPage)).toBeVisible();
    await expect(section(returningPage, 'details')).toHaveCount(0);

    const denied = await read(returning, PROJECT_ROUTES.current);
    expect(denied.status()).toBe(401);

    /* 17. Recover again — the link is reusable, not single-use. */
    await returningPage.goto(created.recoveryLink);
    await expect(section(returningPage, 'details')).toBeVisible();

    /* 18. Open the delete dialog. */
    const dialog = await openDeleteDialog(returningPage);

    /* 19. The wrong confirmation text does not delete anything. */
    const confirmation = dialog.getByRole('textbox', { name: /Type the project name to confirm/ });
    await confirmation.fill('not the project name');
    await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();

    // And the server refuses it too, not merely the disabled button: sent with
    // the browser's own cookies, so the API cannot tell this from the real UI.
    const rejected = await mutate(returning, 'DELETE', PROJECT_ROUTES.delete, {
      version: 6,
      confirmationName: 'not the project name',
    });
    // 422: the request is well-formed, its content is not acceptable.
    expect(rejected.status()).toBe(422);

    const survived = await read(returning, PROJECT_ROUTES.current);
    expect(survived.status()).toBe(200);

    /* 20. Confirm with the exact name. */
    await confirmation.fill('Northwind quoting platform');
    await returningPage.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(returningPage.getByText(/The project has been deleted/)).toBeVisible();

    /* 21. The session is invalidated. */
    const afterDelete = await sessionCookie(returning);
    expect(afterDelete?.value ?? '').toBe('');
    expect((await read(returning, PROJECT_ROUTES.current)).status()).toBe(401);

    /* 22. It cannot be reached again, by session or by recovery link. */
    await returningPage.reload();
    await expect(createPanel(returningPage)).toBeVisible();

    const afterDeletion = await browser.newContext();
    const afterDeletionPage = await afterDeletion.newPage();
    await afterDeletionPage.goto(created.recoveryLink);
    await expect(afterDeletionPage.getByText(PROJECT_ACCESS_DENIED_MESSAGE)).toBeVisible();
    await expect(
      afterDeletionPage.getByRole('link', { name: 'Start a new project' }),
    ).toBeVisible();

    /* 23. A different project's session cannot reach this one. */
    const otherPage = await afterDeletion.newPage();
    await otherPage.goto('/');
    const other = await createProject(otherPage, { name: 'Unrelated project' });
    await enterWorkspace(otherPage);

    const asOther = await read(afterDeletion, PROJECT_ROUTES.current);
    expect(asOther.status()).toBe(200);
    expect(((await asOther.json()) as { projectId: string }).projectId).toBe(other.projectId);
    expect(((await asOther.json()) as { projectId: string }).projectId).not.toBe(created.projectId);

    // There is no request shape that names another project, so the only way to
    // try is the exchange — which needs that project's secret.
    const crossExchange = await mutate(afterDeletion, 'POST', PROJECT_ROUTES.exchange, {
      projectId: created.projectId,
      recoverySecret: other.recoverySecret,
    });
    expect(crossExchange.status()).toBe(401);

    /* The audit trail recorded the whole lifecycle. */
    const events = await readAuditEventTypes(created.projectId);
    expect(events).toContain('PROJECT_CREATED');
    expect(events).toContain('PROJECT_RECOVERED');
    expect(events).toContain('PROJECT_DELETION_REQUESTED');
    expect(events).toContain('PROJECT_DELETED');

    await afterDeletion.close();
    await returning.close();
  });

  /* 24. Expired projects, aged with a database fixture rather than a fake clock. */
  test('an expired project is readable but neither editable nor recoverable', async ({
    page,
    browser,
  }) => {
    await page.goto('/');
    const project = await createProject(page, { name: 'Abandoned discovery' });
    await enterWorkspace(page);

    await expect(projectPanel(page).getByText(project.projectId)).toBeVisible();

    await expireProject(project.projectId);
    await page.reload();

    // Still readable: the user must be able to see and copy out what they had.
    await expect(section(page, 'details')).toBeVisible();
    await expect(page.getByText('EXPIRED', { exact: true })).toBeVisible();

    // But not editable.
    const details = section(page, 'details');
    await details.getByRole('textbox', { name: /Client name/ }).fill('Too late');
    await details.getByRole('button', { name: 'Save details' }).click();
    await expect(details.getByText('Not saved', { exact: true })).toBeVisible();

    // And no longer recoverable: expiry ends the recovery credential's life.
    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();
    await freshPage.goto(project.recoveryLink);
    await expect(freshPage.getByText(PROJECT_ACCESS_DENIED_MESSAGE)).toBeVisible();

    expect(await fresh.cookies()).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ name: PROJECT_SESSION_COOKIE })]),
    );

    await fresh.close();
  });
});
