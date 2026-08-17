import { expect, test, type Page } from '@playwright/test';

import { expectNoAccessibilityViolations } from './support/accessibility';
import { API_URL } from './support/environment';
import { createProject } from './support/workspace';

/**
 * The operator console, as an operator meets it.
 *
 * The suite's API runs with no operator token configured, which is the default and the
 * safe one — so the surface answers 404 and nothing here can talk to a real one. That
 * shapes what this file can honestly test, and it splits cleanly:
 *
 * - **Against the real API:** that the surface is genuinely shut when unconfigured, and
 *   that the console reports being refused rather than showing an empty dashboard.
 * - **Against fulfilled routes:** everything after a token is accepted. The enforcement
 *   is proved against a running application in
 *   `apps/api/test/admin-operations.e2e-spec.ts`, over HTTP, with real tokens; what the
 *   browser layer owns is what an operator *sees*.
 *
 * Standing up a second API instance with a token configured, purely for this file, would
 * double the suite's slowest fixture to re-prove something already proved.
 */

const console_ = (page: Page) => page.getByRole('region', { name: 'Operator sign in' });
const status = (page: Page) => page.getByRole('region', { name: 'System status' });
const queue = (page: Page) => page.getByRole('region', { name: 'Extraction queue' });
const projects = (page: Page) => page.getByRole('region', { name: 'Projects' });
const audit = (page: Page) => page.getByRole('region', { name: 'Recent audit events' });

const TOKEN = 'operator-token-of-sufficient-length-000000';

const STATUS = {
  observedAt: '2026-08-17T09:00:00.000Z',
  version: '0.1.0',
  environment: 'test',
  projects: { DRAFT: 2, ACTIVE: 5, EXPIRED: 1, DELETION_PENDING: 0, DELETED: 3 },
  retention: {
    enabled: false,
    deletionGraceDays: 7,
    expiredGraceDays: 90,
    pendingDeletion: 0,
  },
  rateLimit: { enabled: true, trackedKeys: 4, refusals: { export: 2 } },
  storage: { adapter: 'filesystem', malwareScanner: 'none' },
};

const QUEUE = {
  counts: { queued: 1, running: 1, failed: 2, completed: 9 },
  oldestQueuedSeconds: 12,
  oldestClaimedSeconds: 9_000,
  claimTimeoutSeconds: 180,
  stalled: true,
  observedAt: '2026-08-17T09:00:00.000Z',
};

const PROJECT_ID = 'prj_0123456789ABCDEFGHJKMNPQRS';

const PROJECT_SUMMARY = {
  projectId: PROJECT_ID,
  name: 'Acme portal',
  status: 'ACTIVE',
  effectiveStatus: 'EXPIRED',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
  expiresAt: '2026-08-10T00:00:00.000Z',
};

/** Serves the operator surface from fixtures, for everything past the token. */
async function stubOperatorSurface(page: Page): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route(`${API_URL}/api/v1/admin/status`, (route) => route.fulfill(json(STATUS)));
  await page.route(`${API_URL}/api/v1/admin/queue`, (route) => route.fulfill(json(QUEUE)));
  await page.route(`${API_URL}/api/v1/admin/projects**`, (route) =>
    route.fulfill(json({ projects: [PROJECT_SUMMARY], truncated: false })),
  );
  await page.route(`${API_URL}/api/v1/admin/projects/${PROJECT_ID}`, (route) =>
    route.fulfill(
      json({
        ...PROJECT_SUMMARY,
        counts: {
          requirementSources: 3,
          requirementItems: 12,
          documents: 7,
          documentVersions: 19,
          extractionJobs: 3,
          auditEvents: 84,
        },
        unfinishedJobs: { failed: 1 },
      }),
    ),
  );
  await page.route(`${API_URL}/api/v1/admin/audit**`, (route) =>
    route.fulfill(
      json({
        events: [
          {
            type: 'RATE_LIMIT_EXCEEDED',
            projectId: 'unknown',
            occurredAt: '2026-08-17T08:59:00.000Z',
          },
          { type: 'PROJECT_PURGED', projectId: PROJECT_ID, occurredAt: '2026-08-17T08:58:00.000Z' },
        ],
        truncated: false,
      }),
    ),
  );
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/admin');
  await console_(page).getByTestId('admin-token').fill(TOKEN);
  await console_(page).getByTestId('admin-sign-in').click();
}

test.describe('The operator console', () => {
  test('is shut when no operator token is configured', async ({ page }) => {
    /*
     * The real API, with the default configuration: no token set, so the surface answers
     * as though the routes do not exist. The console must say it was refused rather than
     * present an empty dashboard, which would read as "nothing is happening".
     */
    await page.goto('/admin');

    await expect(console_(page)).toBeVisible();

    await console_(page).getByTestId('admin-token').fill(TOKEN);
    await console_(page).getByTestId('admin-sign-in').click();

    const error = console_(page).getByTestId('admin-error');

    await expect(error).toBeVisible({ timeout: 30_000 });
    await expect(error).toContainText(/not enabled|not accepted/i);

    /* Still on the sign-in card: a refusal does not open the console. */
    await expect(page.getByRole('region', { name: 'System status' })).toHaveCount(0);
  });

  test('asks for a token before showing anything', async ({ page }) => {
    await page.goto('/admin');

    await expect(console_(page)).toBeVisible();
    /* Masked, and the button is unusable until something is typed. */
    await expect(console_(page).getByTestId('admin-token')).toHaveAttribute('type', 'password');
    await expect(console_(page).getByTestId('admin-sign-in')).toBeDisabled();
  });

  test('never writes the token to browser storage', async ({ page }) => {
    await stubOperatorSurface(page);
    await signIn(page);

    await expect(status(page)).toBeVisible();

    /*
     * The property that matters most on a shared machine: the token is in memory for the
     * life of the tab and nowhere a later script or user could read it.
     */
    const stored = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      cookies: document.cookie,
    }));

    expect(stored.local).not.toContain(TOKEN);
    expect(stored.session).not.toContain(TOKEN);
    expect(stored.cookies).not.toContain(TOKEN);
  });

  test('shows system status once the token is accepted', async ({ page }) => {
    await stubOperatorSurface(page);
    await signIn(page);

    await expect(status(page)).toBeVisible();
    await expect(status(page).getByTestId('admin-environment')).toHaveText('test');
    await expect(status(page).getByTestId('admin-projects-ACTIVE')).toHaveText('5');
    await expect(status(page).getByTestId('admin-pending-deletion')).toHaveText('0');
    /* Retention is off in the fixture, and the console says so rather than staying quiet. */
    await expect(status(page).getByText('Retention off')).toBeVisible();
  });

  test('shows the queue, and says plainly when a job is stuck', async ({ page }) => {
    await stubOperatorSurface(page);
    await signIn(page);

    await queue(page).getByTestId('admin-refresh-queue').click();

    await expect(queue(page).getByTestId('admin-queue-failed')).toHaveText('2');
    /* The whole reason this view exists: a claimed job past its reclaim window. */
    await expect(queue(page).getByTestId('admin-queue-stalled')).toBeVisible();
    await expect(queue(page).getByTestId('admin-queue-ages')).toContainText('reclaim after 180s');
  });

  test('searches a project and shows its metadata, and no content', async ({ page }) => {
    await stubOperatorSurface(page);
    await signIn(page);

    await projects(page).getByTestId('admin-project-search').fill(PROJECT_ID);
    await projects(page).getByTestId('admin-find-projects').click();

    await expect(projects(page).getByTestId('admin-project-list')).toContainText(PROJECT_ID);

    await projects(page).getByTestId(`admin-open-${PROJECT_ID}`).click();

    const detail = projects(page).getByTestId('admin-project-detail');

    await expect(detail).toBeVisible();

    /* Counts and the two statuses — the difference is the support answer. */
    await expect(detail.getByTestId('admin-count-documents')).toHaveText('7');
    await expect(detail).toContainText('Stored ACTIVE');
    await expect(detail).toContainText('effective EXPIRED');
    await expect(projects(page).getByTestId('admin-unfinished-jobs')).toContainText('failed 1');
  });

  test('shows recent audit events', async ({ page }) => {
    await stubOperatorSurface(page);
    await signIn(page);

    await audit(page).getByTestId('admin-refresh-audit').click();

    const list = audit(page).getByTestId('admin-audit-list');

    await expect(list).toContainText('RATE_LIMIT_EXCEEDED');
    await expect(list).toContainText('PROJECT_PURGED');
  });

  test('retries a job by id and reports a refusal honestly', async ({ page }) => {
    await stubOperatorSurface(page);
    await signIn(page);

    await queue(page).getByTestId('admin-refresh-queue').click();
    await expect(queue(page).getByTestId('admin-queue-failed')).toHaveText('2');

    /* A job id that does not exist: the API answers 404, and the console says so. */
    await page.route(`${API_URL}/api/v1/admin/queue/job_missing/retry`, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'NOT_FOUND',
            message: 'No job with that id is waiting to be retried.',
            status: 404,
          },
        }),
      }),
    );

    await queue(page).getByTestId('admin-job-id').fill('job_missing');
    await queue(page).getByTestId('admin-retry-job').click();

    await expect(page.getByTestId('admin-error')).toContainText('No job with that id');
  });

  test('does not appear in the workspace a client uses', async ({ page }) => {
    /*
     * The console is for whoever runs the deployment. Nothing in the product should link
     * a client to it, and this is the assertion that keeps it that way.
     */
    await page.goto('/');
    await createProject(page, { name: 'No operator link here' });

    await expect(page.getByRole('link', { name: /admin|operator/i })).toHaveCount(0);
  });

  test.describe('the console stays usable', () => {
    for (const [name, viewport] of [
      ['a phone', { width: 390, height: 844 }],
      ['a tablet', { width: 768, height: 1024 }],
      ['a desktop', { width: 1440, height: 900 }],
    ] as const) {
      test(`on ${name}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await stubOperatorSurface(page);

        await page.goto('/admin');
        await expectNoAccessibilityViolations(page);

        await signIn(page);
        await expect(status(page)).toBeVisible();

        await queue(page).getByTestId('admin-refresh-queue').click();
        await expect(queue(page).getByTestId('admin-queue-failed')).toBeVisible();

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );

        expect(overflow).toBeLessThanOrEqual(1);

        await expectNoAccessibilityViolations(page);
      });
    }
  });
});
