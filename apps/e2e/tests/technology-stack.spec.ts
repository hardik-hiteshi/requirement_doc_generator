import { expect, test, type Page } from '@playwright/test';

import { expectNoAccessibilityViolations } from './support/accessibility';
import { API_URL } from './support/environment';
import { createProject, enterWorkspace, saveSection, section } from './support/workspace';

/**
 * Choosing a technology stack, driven through a real browser.
 *
 * The API runs with the deterministic provider, so what is under test here is
 * the *interface*: whether a reviewer can see who decided each technology,
 * whether a suggestion is visibly a suggestion, whether the approval gate
 * refuses, and whether a locked stack actually stops changing.
 *
 * As in the Phase 4 suite, the most important assertions are the negative ones.
 * Nothing is chosen on the user's behalf, a suggestion never quietly becomes a
 * decision, and a locked component does not move — and the screen has to make
 * all three visible rather than merely be true underneath.
 */

const stackPanel = (page: Page) => page.getByRole('region', { name: 'Technology stack' });
const findingsPanel = (page: Page) => page.getByRole('region', { name: 'What to look at' });

/** A project of the given type, sitting on the technology-stack step. */
async function reachStack(
  page: Page,
  options: { readonly projectType: string; readonly text: string },
): Promise<void> {
  await page.goto('/');
  await createProject(page, { name: 'Technology stack' });
  await enterWorkspace(page);

  const details = section(page, 'details');
  await details.getByRole('checkbox', { name: options.projectType, exact: true }).check();
  await saveSection(page, 'details');

  const timeline = section(page, 'timeline');
  await timeline.getByRole('radio', { name: 'Weeks', exact: true }).check();
  await saveSection(page, 'timeline');

  await page.getByRole('button', { name: 'Continue to requirement input' }).click();

  const paste = page.getByRole('region', { name: 'Paste requirement text', exact: true });
  await paste.getByRole('textbox', { name: /Source title/ }).fill('Client brief');
  await paste.getByRole('textbox', { name: /Requirement text/ }).fill(options.text);
  await paste.getByRole('button', { name: 'Add requirement text' }).click();

  const sources = page.getByRole('region', { name: 'Requirement sources', exact: true });
  const row = sources.getByRole('listitem').filter({ hasText: 'Client brief' });
  await expect(row.getByText(/Ready|Needs your review/)).toBeVisible({ timeout: 60_000 });

  await sources.getByRole('button', { name: 'Client brief' }).click();

  const review = page.getByRole('region', { name: 'Extraction review', exact: true });
  await review.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(review.getByRole('button', { name: 'Reviewed' })).toBeDisabled();

  await page.getByRole('button', { name: 'Continue to requirement analysis' }).click();

  /*
   * The stack is decided against an *approved* baseline, so the browser flow
   * has to earn one first. This is the honest path a user takes, and it is why
   * the stack step opens with a blocker rather than an empty form when nobody
   * has approved anything.
   */
  await page.getByRole('button', { name: 'Analyse my requirements' }).click();
  await expect(
    page.getByRole('region', { name: 'Requirement analysis', exact: true }).getByText('Complete'),
  ).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Baseline approval' }).click();

  const baseline = page.getByRole('region', { name: /Requirement baseline/ });
  await expect(baseline).toBeVisible();

  await page.getByRole('checkbox', { name: /I have read these requirements/ }).check();
  await page.getByRole('button', { name: 'Approve this baseline' }).click();
  await expect(baseline.getByText('Approved')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Technology stack' }).click();
  await expect(stackPanel(page)).toBeVisible();
}

const WEB_APP_TEXT = [
  'Staff must sign in and record their weekly timesheets.',
  'A manager must approve every timesheet before it is exported.',
].join('\n');

/**
 * Walks back to the stack step after a reload.
 *
 * The workspace holds the current step in component state, so a reload lands on
 * the first step — which is the workflow's own behaviour, not something this
 * phase changes. The point of the reload is to prove the *stack* survived, so
 * the test walks the same path a user would.
 */
async function returnToStack(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue to requirement input' }).click();
  await page.getByRole('button', { name: 'Continue to requirement analysis' }).click();
  await page.getByRole('button', { name: 'Technology stack' }).click();
  await expect(stackPanel(page)).toBeVisible();
}

/**
 * Picks a selection mode.
 *
 * A click rather than `check()`: the radio is controlled by the server's answer,
 * so its state changes when the mutation returns rather than on the click — and
 * `check()` asserts the state before then.
 */
async function setMode(page: Page, label: string): Promise<void> {
  await stackPanel(page).getByRole('radio', { name: label }).click();
  await expect(stackPanel(page).getByRole('radio', { name: label })).toBeChecked({
    timeout: 30_000,
  });
}

/** Chooses a technology from the catalogue for one category. */
async function choose(page: Page, category: string, technology: string): Promise<void> {
  const row = page.getByTestId(`category-${category}`);

  await row.getByRole('button', { name: /^Choose a|^Choose something else$/ }).click();
  await row
    .getByRole('combobox', { name: 'From the catalogue' })
    .selectOption({ label: technology });
  await row.getByRole('button', { name: 'Use this' }).click();
  // The heading of the component card, not any text: the catalogue `<option>`
  // and the licence cell can both carry the same word.
  await expect(row.locator('span.font-medium', { hasText: technology })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe('Technology stack', () => {
  test('the categories offered follow from the project type', async ({ page }) => {
    await reachStack(page, { projectType: 'Web application', text: WEB_APP_TEXT });

    /* 1 & 2. A web application has these. */
    await expect(page.getByTestId('category-web_frontend')).toBeVisible();
    await expect(page.getByTestId('category-backend')).toBeVisible();
    await expect(page.getByTestId('category-database')).toBeVisible();

    /*
     * And not these. An iOS framework on a web application is a deliverable
     * nobody is paying for, and it is not offered at all rather than offered
     * and warned about.
     */
    await expect(page.getByTestId('category-native_ios')).toHaveCount(0);
    await expect(page.getByTestId('category-desktop_framework')).toHaveCount(0);

    /*
     * Nor a cache, a queue or a vector store. Nothing in these requirements
     * asks for them, and a project being "an application" is not a reason.
     */
    await expect(page.getByTestId('category-cache')).toHaveCount(0);
    await expect(page.getByTestId('category-message_queue')).toHaveCount(0);
    await expect(page.getByTestId('category-vector_storage')).toHaveCount(0);
  });

  test('an API-only project is not offered a frontend', async ({ page }) => {
    await reachStack(page, {
      projectType: 'Backend / API system',
      text: 'The service must return a price for a given product and quantity.',
    });

    await expect(page.getByTestId('category-backend')).toBeVisible();
    await expect(page.getByTestId('category-web_frontend')).toHaveCount(0);
  });

  test('the whole stack can be chosen, approved and locked with no AI', async ({ page }) => {
    await reachStack(page, { projectType: 'Web application', text: WEB_APP_TEXT });

    /* 3. The mode that needs no inference server at all. */
    await setMode(page, 'Choose everything myself');
    await expect(page.getByRole('button', { name: 'Suggest technologies' })).toHaveCount(0);

    /* 4, 5, 6. Three decisions, each visibly the user's. */
    await choose(page, 'web_frontend', 'Vue');
    await choose(page, 'backend', 'Laravel');
    await choose(page, 'database', 'MySQL');

    await expect(page.getByTestId('category-database').getByText('Chosen by you')).toBeVisible();

    /* The commercial facts come from the reviewed catalogue, and are shown. */
    const database = page.getByTestId('category-database');
    await expect(database.getByText('GPL-2.0 / commercial')).toBeVisible();

    /* 7. Approval needs an explicit acknowledgement. */
    const approve = page.getByRole('button', { name: 'Approve this stack' });
    await expect(approve).toBeDisabled();

    await page.getByRole('checkbox', { name: /I have read these technologies/ }).check();
    await approve.click();

    await expect(page.getByTestId('stack-status')).toHaveText('Approved', { timeout: 30_000 });

    /* 8. Locking is a second, separate act, with its own acknowledgement. */
    const lock = page.getByRole('button', { name: 'Lock this stack' });
    await expect(lock).toBeDisabled();

    await page.getByRole('checkbox', { name: /locking makes this stack authoritative/ }).check();
    await lock.click();

    await expect(page.getByTestId('stack-status')).toHaveText('Locked', { timeout: 30_000 });

    /* 9. It persists across a reload, and it is still locked. */
    await page.reload();
    await returnToStack(page);

    await expect(page.getByTestId('stack-status')).toHaveText('Locked');
    await expect(page.getByText('MySQL').first()).toBeVisible();

    /* 10. And nothing offers to change it. */
    await expect(
      page.getByRole('button', { name: /^Choose a|^Choose something else$/ }),
    ).toHaveCount(0);
    await expect(page.getByText(/This stack is locked/)).toBeVisible();
  });

  test('a locked stack is reopened only deliberately, and as a new version', async ({ page }) => {
    await reachStack(page, { projectType: 'Web application', text: WEB_APP_TEXT });

    await setMode(page, 'Choose everything myself');
    await choose(page, 'web_frontend', 'React');
    await choose(page, 'backend', 'NestJS');
    await choose(page, 'database', 'PostgreSQL');

    await page.getByRole('checkbox', { name: /I have read these technologies/ }).check();
    await page.getByRole('button', { name: 'Approve this stack' }).click();
    await page.getByRole('checkbox', { name: /locking makes this stack authoritative/ }).check();
    await page.getByRole('button', { name: 'Lock this stack' }).click();

    await expect(page.getByTestId('stack-status')).toHaveText('Locked', { timeout: 30_000 });
    await expect(page.getByText('Stack v1')).toBeVisible();

    /* 11. Reopening asks why, because it invalidates whatever was built on it. */
    await page.getByRole('button', { name: 'Unlock and change it' }).click();

    const reopen = page.getByRole('button', { name: 'Reopen the stack' });
    await expect(reopen).toBeDisabled();
    await expect(page.getByText(/marked out of date/)).toBeVisible();

    await page
      .getByRole('textbox', { name: 'Why are you reopening it?' })
      .fill('The client changed their database.');
    await reopen.click();

    /* 12. A new version. The locked one is untouched. */
    await expect(page.getByText('Stack v2')).toBeVisible({ timeout: 30_000 });
    /* Carried forward, and no longer locked — a new version is locked on purpose. */
    await expect(
      page.getByTestId('category-database').locator('span.font-medium', { hasText: 'PostgreSQL' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Show what has been decided' }).click();
    await expect(page.getByText('Stack v1')).toBeVisible();
  });

  test('the AI suggests, and every suggestion waits for a decision', async ({ page }) => {
    await reachStack(page, { projectType: 'Web application', text: WEB_APP_TEXT });

    /* 13. Ask for suggestions. */
    await setMode(page, 'Let the AI suggest everything');
    await page.getByRole('button', { name: 'Suggest technologies' }).click();

    const database = page.getByTestId('category-database');

    await expect(database.getByText('Suggested')).toBeVisible({ timeout: 60_000 });

    /* 14. The reasoning is shown, and the model's confidence is labelled. */
    await database.getByRole('button', { name: 'Why this one?' }).click();
    await expect(database.getByText(/AI self-assessment/)).toBeVisible();
    await expect(database.getByText(/nothing in this application uses it to decide/)).toBeVisible();

    /*
     * 15. A suggestion nobody has looked at blocks approval. Approving a stack
     * with unread suggestions in it means approving whatever the model said.
     */
    await expect(page.getByRole('heading', { name: /Before you can approve/ })).toBeVisible();
    await expect(page.getByText(/still waiting for you/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve this stack' })).toBeDisabled();

    /* 16. Accept one. */
    await database.getByRole('button', { name: 'Accept' }).click();
    await expect(database.getByText('Approved by you')).toBeVisible({ timeout: 30_000 });

    /* 17. Reject another. */
    const backend = page.getByTestId('category-backend');
    await backend.getByRole('button', { name: 'Reject' }).click();
    await expect(backend.getByText('Nothing chosen yet.')).toBeVisible({ timeout: 30_000 });

    /* 18. Replace the third by hand. */
    const frontend = page.getByTestId('category-web_frontend');
    await frontend.getByRole('button', { name: 'Use something else' }).click();
    await frontend.getByRole('combobox', { name: 'Use instead' }).selectOption({ label: 'Svelte' });
    await frontend.getByRole('textbox', { name: 'Why?' }).fill('The team knows it.');
    await frontend.getByRole('button', { name: 'Replace it' }).click();

    await expect(frontend.getByText('Svelte', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(frontend.getByText(/Replaced React/)).toBeVisible();
    await expect(frontend.getByText('Chosen by you')).toBeVisible();
  });

  test('a chosen technology is never replaced by a suggestion', async ({ page }) => {
    await reachStack(page, { projectType: 'Web application', text: WEB_APP_TEXT });

    /* 19. Hybrid: two decided, the rest left to the AI. */
    await setMode(page, 'I will choose some, the AI suggests the rest');

    await choose(page, 'web_frontend', 'Angular');
    await choose(page, 'backend', 'Django');

    await page.getByRole('button', { name: 'Suggest technologies' }).click();
    await expect(page.getByTestId('category-database').getByText('Suggested')).toBeVisible({
      timeout: 60_000,
    });

    /* Untouched, both of them, and still labelled as the user's. */
    const frontend = page.getByTestId('category-web_frontend');
    await expect(frontend.getByText('Angular', { exact: true })).toBeVisible();
    await expect(frontend.getByText('Chosen by you')).toBeVisible();

    const backend = page.getByTestId('category-backend');
    await expect(backend.getByText('Django', { exact: true })).toBeVisible();
    await expect(backend.getByText('Chosen by you')).toBeVisible();
  });

  test('a technology the application has never heard of is recorded as typed', async ({ page }) => {
    await reachStack(page, { projectType: 'Web application', text: WEB_APP_TEXT });

    const backend = page.getByTestId('category-backend');

    await backend.getByRole('button', { name: /^Choose a/ }).click();
    await backend.getByRole('textbox', { name: 'Or type your own' }).fill('Corvid Framework 3');
    await backend.getByRole('radio', { name: /The client requires it/ }).check();
    await backend.getByRole('button', { name: 'Use this' }).click();

    await expect(backend.getByText('Corvid Framework 3')).toBeVisible({ timeout: 30_000 });
    await expect(backend.getByText('Required by requirements')).toBeVisible();

    /* No invented facts about something nobody reviewed. */
    await expect(backend.getByText(/holds no reviewed licence or cost information/)).toBeVisible();
  });

  test('a warning can be acknowledged, and the choice kept', async ({ page }) => {
    /*
     * 20. The requirements say self-hosted; the user picks a hosted service.
     * The application says so, loudly, and does not change their mind for them.
     */
    await reachStack(page, {
      projectType: 'Web application',
      text: [
        'Everything must be self-hosted on the client’s own servers.',
        'Staff must upload and retrieve case documents.',
      ].join('\n'),
    });

    await choose(page, 'object_storage', 'Amazon S3');

    const findings = findingsPanel(page);

    await expect(findings).toBeVisible({ timeout: 30_000 });
    await expect(findings.getByText(/cannot be self-hosted/)).toBeVisible();
    await expect(findings.getByRole('heading', { name: /Cannot be approved/ })).toBeVisible();

    /* The choice is still there. The application reports; it does not overrule. */
    await expect(page.getByTestId('category-object_storage').getByText('Amazon S3')).toBeVisible();

    /* And a blocking contradiction offers no acknowledgement button. */
    const blocking = findings.getByTestId('finding-self_hosting_violation');
    await expect(blocking.getByRole('button', { name: /Acknowledge/ })).toHaveCount(0);
  });

  test('the stack goes out of date when the requirements move on', async ({ page }) => {
    await reachStack(page, { projectType: 'Web application', text: WEB_APP_TEXT });

    await setMode(page, 'Choose everything myself');
    await choose(page, 'web_frontend', 'React');
    await choose(page, 'backend', 'NestJS');
    await choose(page, 'database', 'PostgreSQL');

    await page.getByRole('checkbox', { name: /I have read these technologies/ }).check();
    await page.getByRole('button', { name: 'Approve this stack' }).click();
    await expect(page.getByTestId('stack-status')).toHaveText('Approved', { timeout: 30_000 });

    /* 19. A document arrives after the stack was decided. */
    await page.getByRole('button', { name: 'Back to requirement input' }).click();

    const paste = page.getByRole('region', { name: 'Paste requirement text', exact: true });
    await paste.getByRole('textbox', { name: /Source title/ }).fill('Late addition');
    await paste
      .getByRole('textbox', { name: /Requirement text/ })
      .fill('Timesheets must also be exported as PDF.');
    await paste.getByRole('button', { name: 'Add requirement text' }).click();

    const sources = page.getByRole('region', { name: 'Requirement sources', exact: true });
    const row = sources.getByRole('listitem').filter({ hasText: 'Late addition' });
    await expect(row.getByText(/Ready|Needs your review/)).toBeVisible({ timeout: 60_000 });

    await sources.getByRole('button', { name: 'Late addition' }).click();

    const review = page.getByRole('region', { name: 'Extraction review', exact: true });
    await review.getByRole('button', { name: 'Mark reviewed' }).click();
    // Waited for: navigating before the review lands means the baseline has not
    // been told the world moved, and the stack has nothing to notice.
    await expect(review.getByRole('button', { name: 'Reviewed' })).toBeDisabled();

    /* 20. The stack says so, and nothing in it was regenerated. */
    await page.getByRole('button', { name: 'Continue to requirement analysis' }).click();
    await page.getByRole('button', { name: 'Technology stack' }).click();

    await expect(stackPanel(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Before you can approve/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText('The requirements have changed since this stack was set.'),
    ).toBeVisible();
    await expect(
      page.getByTestId('category-database').locator('span.font-medium', { hasText: 'PostgreSQL' }),
    ).toBeVisible();
  });

  test('another project cannot see this one’s stack', async ({ page, context }) => {
    await reachStack(page, { projectType: 'Web application', text: WEB_APP_TEXT });
    await choose(page, 'database', 'PostgreSQL');

    /*
     * A second browser context is a different session, and the API scopes every
     * stack read to the session's own project. What it must not do is show a
     * stranger's technology choices, or reveal that the project exists at all.
     */
    const other = await context.browser()!.newContext();
    const otherPage = await other.newPage();

    await otherPage.goto('/');
    await createProject(otherPage, { name: 'Someone else' });
    await enterWorkspace(otherPage);

    const response = await otherPage.request.get(`${API_URL}/api/v1/projects/current/stack`);
    const body = (await response.json()) as { snapshot?: { components?: unknown[] } };

    expect(response.status()).toBe(200);
    /* Its own empty stack, not this project's. */
    expect(body.snapshot?.components).toEqual([]);

    await other.close();
  });

  test('the technology stack screen is accessible', async ({ page }) => {
    await reachStack(page, { projectType: 'Web application', text: WEB_APP_TEXT });

    await expectNoAccessibilityViolations(page);

    await choose(page, 'database', 'PostgreSQL');
    await expectNoAccessibilityViolations(page);

    await page.getByRole('button', { name: 'Show what has been decided' }).click();
    await expectNoAccessibilityViolations(page);
  });

  /*
   * The three sizes the responsive suite uses, applied to this step. Geometry
   * rather than screenshots: a snapshot fails on a font-rendering difference
   * between a laptop and a CI runner while happily passing a control that has
   * slid off the side of the screen.
   */
  for (const viewport of [
    { name: 'a phone', width: 390, height: 844 },
    { name: 'a tablet', width: 768, height: 1024 },
    { name: 'a desktop', width: 1440, height: 900 },
  ]) {
    test(`the stack step stays usable on ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await reachStack(page, { projectType: 'Web application', text: WEB_APP_TEXT });

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      // One pixel of slack for sub-pixel rounding; anything real is larger.
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
      await expect(page.getByTestId('category-database')).toBeVisible();

      await choose(page, 'database', 'PostgreSQL');
      await expect(page.getByRole('button', { name: 'Approve this stack' })).toBeVisible();
    });
  }
});
