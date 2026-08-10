import { expect, test, type Page } from '@playwright/test';

import { CSRF_COOKIE } from '@wdrg/contracts';

import { API_URL } from './support/environment';
import { expectNoAccessibilityViolations } from './support/accessibility';
import { createProject, enterWorkspace, saveSection, section } from './support/workspace';

/**
 * Estimation and the delivery timeline, driven through a real browser.
 *
 * The API runs with the deterministic provider, so what is under test is the
 * *interface*: whether a reader can tell effort from capacity from duration,
 * whether a figure they set stays theirs, whether the deadline they asked for
 * is reported honestly, and whether moving a date leaves the hours alone.
 *
 * As throughout this suite, the important assertions are the negative ones.
 * Nothing extends a timeline, nothing overwrites an override, and nothing
 * invents a calendar date.
 */

const estimationPanel = (page: Page) =>
  page.getByRole('region', { name: 'Estimation and timeline' });
const effortPanel = (page: Page) => page.getByRole('region', { name: 'Effort', exact: true });
const capacityPanel = (page: Page) => page.getByRole('region', { name: 'Capacity', exact: true });
const schedulePanel = (page: Page) => page.getByRole('region', { name: 'Schedule', exact: true });
const feasibilityPanel = (page: Page) => page.getByRole('region', { name: 'Delivery feasibility' });

const BRIEF = [
  'Staff must sign in and record their weekly timesheets.',
  'A manager must approve every timesheet before it is exported.',
  'The system must keep a history of every approval.',
].join('\n');

/**
 * A project with an approved baseline, a locked stack and a timeline, sitting
 * on the estimation step.
 *
 * Long, because that is genuinely what the workflow requires — and the length
 * is itself the point: an estimate is only meaningful once the requirements are
 * signed off and the technologies committed to.
 */
async function reachEstimation(
  page: Page,
  options: { readonly weeks?: number; readonly deadline?: string; readonly startDate?: string } = {
    weeks: 12,
  },
): Promise<void> {
  await page.goto('/');
  await createProject(page, { name: 'Estimation' });
  await enterWorkspace(page);

  const details = section(page, 'details');
  await details.getByRole('checkbox', { name: 'Web application', exact: true }).check();
  await saveSection(page, 'details');

  const timeline = section(page, 'timeline');

  if (options.deadline) {
    await timeline.getByRole('radio', { name: 'Fixed client deadline', exact: true }).check();
    await timeline.getByRole('textbox').fill(options.deadline);
  } else {
    await timeline.getByRole('radio', { name: 'Weeks', exact: true }).check();
    await timeline.getByRole('spinbutton').fill(String(options.weeks ?? 12));
  }

  await saveSection(page, 'timeline');

  if (options.startDate) {
    const startDate = section(page, 'startDate');
    await startDate.getByRole('radio', { name: /Confirmed start date/ }).check();
    await startDate.getByRole('textbox').fill(options.startDate);
    await saveSection(page, 'startDate');
  }

  await page.getByRole('button', { name: 'Continue to requirement input' }).click();

  const paste = page.getByRole('region', { name: 'Paste requirement text', exact: true });
  await paste.getByRole('textbox', { name: /Source title/ }).fill('Client brief');
  await paste.getByRole('textbox', { name: /Requirement text/ }).fill(BRIEF);
  await paste.getByRole('button', { name: 'Add requirement text' }).click();

  const sources = page.getByRole('region', { name: 'Requirement sources', exact: true });
  const row = sources.getByRole('listitem').filter({ hasText: 'Client brief' });
  await expect(row.getByText(/Ready|Needs your review/)).toBeVisible({ timeout: 60_000 });

  await sources.getByRole('button', { name: 'Client brief' }).click();

  const review = page.getByRole('region', { name: 'Extraction review', exact: true });
  await review.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(review.getByRole('button', { name: 'Reviewed' })).toBeDisabled();

  await page.getByRole('button', { name: 'Continue to requirement analysis' }).click();
  await page.getByRole('button', { name: 'Analyse my requirements' }).click();
  await expect(
    page.getByRole('region', { name: 'Requirement analysis', exact: true }).getByText('Complete'),
  ).toBeVisible({ timeout: 60_000 });

  await page.getByRole('button', { name: 'Baseline approval' }).click();
  await page.getByRole('checkbox', { name: /I have read these requirements/ }).check();
  await page.getByRole('button', { name: 'Approve this baseline' }).click();
  await expect(
    page.getByRole('region', { name: /Requirement baseline/ }).getByText('Approved'),
  ).toBeVisible({ timeout: 30_000 });

  /* The locked stack. Estimation refuses to price a stack nobody committed to. */
  await page.getByRole('button', { name: 'Technology stack' }).click();

  for (const [category, technology] of [
    ['web_frontend', 'React'],
    ['backend', 'NestJS'],
    ['database', 'PostgreSQL'],
  ] as const) {
    const categoryRow = page.getByTestId(`category-${category}`);

    await categoryRow.getByRole('button', { name: /^Choose a|^Choose something else$/ }).click();
    await categoryRow
      .getByRole('combobox', { name: 'From the catalogue' })
      .selectOption({ label: technology });
    await categoryRow.getByRole('button', { name: 'Use this' }).click();
    await expect(categoryRow.locator('span.font-medium', { hasText: technology })).toBeVisible({
      timeout: 30_000,
    });
  }

  await page.getByRole('checkbox', { name: /I have read these technologies/ }).check();
  await page.getByRole('button', { name: 'Approve this stack' }).click();
  await page.getByRole('checkbox', { name: /locking makes this stack authoritative/ }).check();
  await page.getByRole('button', { name: 'Lock this stack' }).click();
  await expect(page.getByTestId('stack-status')).toHaveText('Locked', { timeout: 30_000 });

  await page.getByRole('button', { name: 'Estimation & timeline' }).click();
  await expect(estimationPanel(page)).toBeVisible();
}

/** Runs the deterministic estimation and waits for the lines to appear. */
async function estimate(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Estimate without AI' }).click();
  await expect(effortPanel(page)).toBeVisible({ timeout: 60_000 });
}

test.describe('Estimation and timeline', () => {
  test('shows effort, capacity and duration as three separate things', async ({ page }) => {
    await reachEstimation(page);

    /* 1 & 2. The estimate opens against the approved baseline and locked stack. */
    await expect(estimationPanel(page).getByText('Baseline v1')).toBeVisible();
    await expect(estimationPanel(page).getByText('Stack v1')).toBeVisible();

    /* 3. And against the timeline the user set, unchanged. */
    await expect(page.getByTestId('required-timeline')).toHaveText('12 weeks');

    /* 4. Run it. */
    await estimate(page);

    /* 5. Effort is hours, with a range rather than a single figure. */
    await expect(page.getByTestId('effort-optimistic')).toBeVisible();
    await expect(page.getByTestId('effort-expected')).toBeVisible();
    await expect(page.getByTestId('effort-conservative')).toBeVisible();
    await expect(effortPanel(page).getByText('If it goes well')).toBeVisible();
    await expect(effortPanel(page).getByText('If it does not')).toBeVisible();
    await expect(effortPanel(page).getByText('By role')).toBeVisible();

    /* 6. Overhead is named rather than folded into a percentage. */
    await expect(
      effortPanel(page).getByText(/setup, review, regression, coordination, release/),
    ).toBeVisible();

    /* 7. Capacity is its own panel, and says what it does not know. */
    await expect(capacityPanel(page)).toBeVisible();
    await expect(
      capacityPanel(page).getByText(/have not told us who is on the team/),
    ).toBeVisible();

    /* 8. Duration is its own panel again, from the schedule. */
    await expect(schedulePanel(page)).toBeVisible();
    await expect(page.getByTestId('schedule-days')).not.toHaveText('0');
  });

  test('recommends a team when none is supplied, and keeps fractions honest', async ({ page }) => {
    await reachEstimation(page);
    await estimate(page);

    await expect(page.getByTestId('feasibility-status')).toHaveText('Tell us about the team');

    /* Fractional roles are explained rather than rounded up. */
    await expect(
      capacityPanel(page)
        .getByText(/not a full-time person/)
        .first(),
    ).toBeVisible();
  });

  test('reports complexity and uncertainty separately on each line', async ({ page }) => {
    await reachEstimation(page);
    await estimate(page);

    const table = page.getByRole('region', { name: 'Estimate lines' });

    await expect(table).toBeVisible();

    /* 9. Every line explains its complexity in words. */
    const first = table.getByTestId(/^estimate-E-/).first();

    await expect(first).toBeVisible();
    await expect(first.getByText(/ordinary work|Low:|Medium:|High:/)).toBeVisible();
  });

  test('a figure you set stays yours through a re-estimation', async ({ page }) => {
    await reachEstimation(page);
    await estimate(page);

    const table = page.getByRole('region', { name: 'Estimate lines' });
    const line = table.getByTestId(/^estimate-E-/).first();
    const key = (await line.getAttribute('data-testid'))!.replace('estimate-', '');

    /* 10. Change it. */
    await line.getByRole('button', { name: 'Change this figure' }).click();
    await line.getByTestId('hours-input-BACKEND').fill('99');
    await line.getByRole('textbox', { name: 'Why?' }).fill('We have built this before.');
    const [response] = await Promise.all([
      page.waitForResponse((candidate) => candidate.url().includes('/estimation/estimates/'), {
        timeout: 20_000,
      }),
      line.getByRole('button', { name: 'Save my figure' }).click(),
    ]);

    if (!response.ok()) {
      throw new Error(`Override refused (${response.status()}): ${await response.text()}`);
    }

    await expect(page.getByTestId(`estimate-${key}`).getByText('Your figure')).toBeVisible({
      timeout: 30_000,
    });

    /*
     * The override changes the backend hours and leaves the other roles as they
     * were, so the line total is 99 plus those — which is the behaviour a user
     * expects from editing one column.
     */
    const overriddenTotal = (await page.getByTestId(`hours-${key}`).textContent())!;

    expect(Number.parseInt(overriddenTotal, 10)).toBeGreaterThanOrEqual(99);

    /* 11. Re-estimate, and it is untouched. */
    await page.getByRole('button', { name: 'Estimate without AI' }).click();
    await expect(page.getByTestId(`estimate-${key}`).getByText('Your figure')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId(`hours-${key}`)).toHaveText(overriddenTotal);
    await expect(
      page.getByTestId(`estimate-${key}`).getByText(/Was .* before you changed it/),
    ).toBeVisible();

    /* 12. And it can be put back. */
    await page
      .getByTestId(`estimate-${key}`)
      .getByRole('button', { name: 'Back to the calculated figure' })
      .click();

    await expect(page.getByTestId(`estimate-${key}`).getByText('Calculated')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId(`hours-${key}`)).not.toHaveText(overriddenTotal);
  });

  test('a project with no start date gets working days, not invented dates', async ({ page }) => {
    await reachEstimation(page);
    await estimate(page);

    /* 13 & 14. Relative, and it says so. */
    await expect(page.getByTestId('schedule-mode')).toHaveText('Relative to the start');
    await expect(
      schedulePanel(page).getByText(/Set a start date in project details/),
    ).toBeVisible();
    await expect(
      schedulePanel(page)
        .getByText(/^Day \d+ → \d+/)
        .first(),
    ).toBeVisible();
  });

  test('a start date produces real dates, and moving it leaves the hours alone', async ({
    page,
  }) => {
    /* 15 & 16. With a confirmed date, the schedule is a calendar. */
    await reachEstimation(page, { weeks: 12, startDate: '2026-09-07' });
    await estimate(page);

    await expect(page.getByTestId('schedule-mode')).toHaveText('Actual');
    await expect(schedulePanel(page).getByText(/From 2026-09-07 to/)).toBeVisible();

    const hoursBefore = await page.getByTestId('effort-expected').textContent();
    const daysBefore = await page.getByTestId('schedule-days').textContent();

    /* 17. Move the date. */
    await page.getByRole('button', { name: 'Back to requirement input' }).click();
    await page.getByRole('button', { name: 'Project details' }).click();

    const startDate = section(page, 'startDate');
    await startDate.getByRole('textbox').fill('2026-11-02');
    await saveSection(page, 'startDate');

    await page.getByRole('button', { name: 'Continue to requirement input' }).click();
    await page.getByRole('button', { name: 'Continue to requirement analysis' }).click();
    await page.getByRole('button', { name: 'Estimation & timeline' }).click();

    await page.getByRole('button', { name: 'Recalculate the dates' }).click();
    await expect(schedulePanel(page).getByText(/From 2026-11-02 to/)).toBeVisible({
      timeout: 30_000,
    });

    /* 18. The effort and the length are exactly as they were. */
    await expect(page.getByTestId('effort-expected')).toHaveText(hoursBefore!);
    await expect(page.getByTestId('schedule-days')).toHaveText(daysBefore!);
    await expect(
      schedulePanel(page).getByText(/your overrides and what waits for what are all untouched/),
    ).toBeVisible();
  });

  test('a fixed deadline with no start date is conditional, and resolves when one arrives', async ({
    page,
  }) => {
    /* A real client deadline, and nobody has agreed when work starts. */
    await reachEstimation(page, { deadline: '2026-12-18' });
    await estimate(page);

    /* The deadline is on screen exactly as it was set. */
    await expect(page.getByTestId('required-timeline')).toHaveText('delivery by 2026-12-18');

    /* The verdict says it cannot be reached yet, and says why. */
    await expect(page.getByTestId('feasibility-determinacy')).toHaveText(
      'Not yet fully determinable',
    );
    await expect(page.getByTestId('feasibility-status')).toHaveText('We need a start date');
    await expect(page.getByTestId('missing-concrete_start_date')).toBeVisible();
    await expect(
      feasibilityPanel(page).getByText(/Your delivery date is unchanged and kept for later/),
    ).toBeVisible();

    /* The hours are final all the same, and the schedule is relative only. */
    const hoursBefore = await page.getByTestId('effort-expected').textContent();
    const daysBefore = await page.getByTestId('schedule-days').textContent();
    await expect(page.getByTestId('schedule-mode')).toHaveText('Relative to the start');

    /* No plausible-looking calendar date anywhere in the schedule. */
    expect(await schedulePanel(page).innerText()).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    /* Now somebody confirms a start date. */
    await page.getByRole('button', { name: 'Back to requirement input' }).click();
    await page.getByRole('button', { name: 'Project details' }).click();

    const startDate = section(page, 'startDate');
    await startDate.getByRole('radio', { name: /Confirmed start date/ }).check();
    await startDate.getByRole('textbox').fill('2026-09-07');
    await saveSection(page, 'startDate');

    await page.getByRole('button', { name: 'Continue to requirement input' }).click();
    await page.getByRole('button', { name: 'Continue to requirement analysis' }).click();
    await page.getByRole('button', { name: 'Estimation & timeline' }).click();

    await page.getByRole('button', { name: 'Recalculate the dates' }).click();
    await expect(schedulePanel(page).getByText(/From 2026-09-07 to/)).toBeVisible({
      timeout: 30_000,
    });

    /* The question has been answered, so it is no longer asked. */
    await expect(page.getByTestId('missing-concrete_start_date')).toBeHidden();
    await expect(page.getByTestId('feasibility-status')).not.toHaveText('We need a start date');

    /* And the deadline and the hours are exactly what they were. */
    await expect(page.getByTestId('required-timeline')).toHaveText('delivery by 2026-12-18');
    await expect(page.getByTestId('effort-expected')).toHaveText(hoursBefore!);
    await expect(page.getByTestId('schedule-days')).toHaveText(daysBefore!);
  });

  test('an aggressive deadline is reported, acknowledged and approved — never moved', async ({
    page,
  }) => {
    /* 19. One week for three features. */
    await reachEstimation(page, { weeks: 1 });
    await estimate(page);

    /* The deadline is still one week. Nothing adjusted it. */
    await expect(page.getByTestId('required-timeline')).toHaveText('1 week');

    /* 20. Say who is working, and the gap becomes visible. */
    await expect(page.getByTestId('feasibility-status')).toHaveText('Tell us about the team');

    await page.request.put(`${API_URL}/api/v1/projects/current/estimation/team`, {
      headers: { 'x-csrf-token': await csrfToken(page) },
      data: {
        lines: [
          {
            role: 'BACKEND',
            people: 1,
            productiveHoursPerDay: 6.5,
            workingDaysPerWeek: 5,
            availability: 1,
            availableFromDay: 0,
          },
        ],
        expectedVersion: await recordVersion(page),
      },
    });

    await page.reload();
    await returnToEstimation(page);

    await expect(feasibilityPanel(page)).toBeVisible();
    await expect(page.getByTestId('feasibility-status')).not.toHaveText('Tell us about the team');
    await expect(page.getByTestId('feasibility-reason')).toBeVisible();
    /* Five working days — exactly what was asked for. */
    await expect(feasibilityPanel(page).getByText('5 working days')).toBeVisible();

    /* 21. Approval is refused until the risk is acknowledged. */
    await expect(page.getByRole('heading', { name: /Before you can approve/ })).toBeVisible();
    await expect(
      page.getByText(/timeline is at risk and nobody has acknowledged it/),
    ).toBeVisible();

    await feasibilityPanel(page)
      .getByRole('button', { name: 'I have read this and I am proceeding' })
      .click();

    await expect(feasibilityPanel(page).getByText(/read this and chose to proceed/)).toBeVisible({
      timeout: 30_000,
    });

    /* 22. And now it can be approved — with the risk on the record. */
    await page.getByRole('checkbox', { name: /I have read this estimate/ }).check();
    await page.getByRole('button', { name: 'Approve this estimate' }).click();

    await expect(page.getByTestId('estimate-status')).toHaveText('Approved', { timeout: 30_000 });
    await expect(page.getByTestId('feasibility-status')).not.toHaveText('Achievable');

    /* 23. It persists across a reload. */
    await page.reload();
    await returnToEstimation(page);

    await expect(page.getByTestId('estimate-status')).toHaveText('Approved');
  });

  test('changing the requirements marks the estimate out of date without altering it', async ({
    page,
  }) => {
    await reachEstimation(page);
    await estimate(page);

    const hoursBefore = await page.getByTestId('effort-expected').textContent();

    /* 24. A document arrives after the estimate was made. */
    await page.getByRole('button', { name: 'Back to requirement input' }).click();

    const paste = page.getByRole('region', { name: 'Paste requirement text', exact: true });
    await paste.getByRole('textbox', { name: /Source title/ }).fill('Late addition');
    await paste
      .getByRole('textbox', { name: /Requirement text/ })
      .fill('Timesheets must also be exported as a PDF.');
    await paste.getByRole('button', { name: 'Add requirement text' }).click();

    const sources = page.getByRole('region', { name: 'Requirement sources', exact: true });
    const row = sources.getByRole('listitem').filter({ hasText: 'Late addition' });
    await expect(row.getByText(/Ready|Needs your review/)).toBeVisible({ timeout: 60_000 });

    await sources.getByRole('button', { name: 'Late addition' }).click();

    const review = page.getByRole('region', { name: 'Extraction review', exact: true });
    await review.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(review.getByRole('button', { name: 'Reviewed' })).toBeDisabled();

    /* 25. The estimate says so, and nothing in it moved. */
    await page.getByRole('button', { name: 'Continue to requirement analysis' }).click();
    await page.getByRole('button', { name: 'Estimation & timeline' }).click();

    await expect(page.getByRole('heading', { name: /Before you can approve/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText('The requirements changed after this estimate was made.'),
    ).toBeVisible();
    await expect(page.getByTestId('effort-expected')).toHaveText(hoursBefore!);
  });

  test('another project cannot see this one’s estimate', async ({ page, context }) => {
    await reachEstimation(page);
    await estimate(page);

    /* 26. A separate session gets its own empty estimate, not this one. */
    const other = await context.browser()!.newContext();
    const otherPage = await other.newPage();

    await otherPage.goto('/');
    await createProject(otherPage, { name: 'Someone else' });
    await enterWorkspace(otherPage);

    const response = await otherPage.request.get(`${API_URL}/api/v1/projects/current/estimation`);
    const body = (await response.json()) as { snapshot?: { estimates?: unknown[] } };

    expect(response.status()).toBe(200);
    expect(body.snapshot?.estimates).toEqual([]);

    await other.close();
  });

  test('the estimation screen is accessible', async ({ page }) => {
    await reachEstimation(page);

    await expectNoAccessibilityViolations(page);

    await estimate(page);
    await expectNoAccessibilityViolations(page);

    await page.getByRole('button', { name: 'Show every task' }).click();
    await expectNoAccessibilityViolations(page);
  });

  /*
   * The three sizes the responsive suite uses. Geometry rather than
   * screenshots: a snapshot fails on a font-rendering difference while happily
   * passing a control that has slid off the side of the screen.
   */
  for (const viewport of [
    { name: 'a phone', width: 390, height: 844 },
    { name: 'a tablet', width: 768, height: 1024 },
    { name: 'a desktop', width: 1440, height: 900 },
  ]) {
    test(`the estimation step stays usable on ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await reachEstimation(page);
      await estimate(page);

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      // One pixel of slack for sub-pixel rounding; anything real is larger.
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
      await expect(effortPanel(page)).toBeVisible();
      await expect(feasibilityPanel(page)).toBeVisible();
    });
  }
});

/** Walks back to the estimation step after a reload. */
async function returnToEstimation(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue to requirement input' }).click();
  await page.getByRole('button', { name: 'Continue to requirement analysis' }).click();
  await page.getByRole('button', { name: 'Estimation & timeline' }).click();
  await expect(estimationPanel(page)).toBeVisible();
}

async function csrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();

  return cookies.find((cookie) => cookie.name === CSRF_COOKIE)?.value ?? '';
}

async function recordVersion(page: Page): Promise<number> {
  const response = await page.request.get(`${API_URL}/api/v1/projects/current/estimation`);
  const body = (await response.json()) as { snapshot: { recordVersion: number } };

  return body.snapshot.recordVersion;
}
