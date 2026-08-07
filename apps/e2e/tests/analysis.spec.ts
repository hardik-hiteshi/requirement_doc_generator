import { expect, test, type Page } from '@playwright/test';

import { expectNoAccessibilityViolations } from './support/accessibility';
import { createProject, enterWorkspace, saveSection, section } from './support/workspace';

/**
 * The Phase 4 workflow, driven through a real browser.
 *
 * The API runs with the deterministic provider, so what is under test here is
 * the *interface*: whether a reviewer can see why a requirement is trusted or
 * not, whether the two confidences are distinguishable, whether the approval
 * gate actually refuses.
 *
 * The most important assertions in this file are the negative ones. Nothing is
 * merged, resolved or assumed on the user's behalf, and the screen has to make
 * that visible rather than merely be true underneath.
 */

const analysisPanel = (page: Page) =>
  page.getByRole('region', { name: 'Requirement analysis', exact: true });
const requirementsPanel = (page: Page) =>
  page.getByRole('region', { name: 'Requirements', exact: true });
const findingsPanel = (page: Page) =>
  page.getByRole('region', { name: 'What needs your decision', exact: true });
const clarificationsPanel = (page: Page) =>
  page.getByRole('region', { name: 'Clarification questions', exact: true });
const baselinePanel = (page: Page) => page.getByRole('region', { name: /Requirement baseline/ });

/** A project with one reviewed source, sitting on the analysis step. */
async function reachAnalysis(page: Page): Promise<void> {
  await page.goto('/');
  await createProject(page, { name: 'Requirement analysis' });
  await enterWorkspace(page);

  const timeline = section(page, 'timeline');
  await timeline.getByRole('radio', { name: 'Weeks', exact: true }).check();
  await saveSection(page, 'timeline');

  await page.getByRole('button', { name: 'Continue to requirement input' }).click();

  const paste = page.getByRole('region', { name: 'Paste requirement text', exact: true });
  await paste.getByRole('textbox', { name: /Source title/ }).fill('Client brief');
  await paste
    .getByRole('textbox', { name: /Requirement text/ })
    .fill(
      [
        'The system must let a sales user build a quote.',
        'A manager must approve every quote before it is sent to the customer.',
        'Quotes must be sent within 24 hours.',
      ].join('\n'),
    );
  await paste.getByRole('button', { name: 'Add requirement text' }).click();

  const sources = page.getByRole('region', { name: 'Requirement sources', exact: true });
  const row = sources.getByRole('listitem').filter({ hasText: 'Client brief' });
  await expect(row.getByText(/Ready|Needs your review/)).toBeVisible({ timeout: 60_000 });

  await sources.getByRole('button', { name: 'Client brief' }).click();

  const review = page.getByRole('region', { name: 'Extraction review', exact: true });
  await review.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(review.getByRole('button', { name: 'Reviewed' })).toBeDisabled();

  // Only now does the step unlock: analysis needs *reviewed* content, and the
  // workflow says so rather than offering a button that cannot work.
  await page.getByRole('button', { name: 'Continue to requirement analysis' }).click();
}

test.describe('Requirement analysis', () => {
  test('the analysis step is locked until something has been reviewed', async ({ page }) => {
    await page.goto('/');
    await createProject(page, { name: 'Locked analysis' });
    await enterWorkspace(page);

    const timeline = section(page, 'timeline');
    await timeline.getByRole('radio', { name: 'Weeks', exact: true }).check();
    await saveSection(page, 'timeline');

    await page.getByRole('button', { name: 'Continue to requirement input' }).click();

    await expect(
      page.getByText('Mark at least one source as reviewed to unlock requirement analysis.'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Continue to requirement analysis' }),
    ).toHaveCount(0);
  });

  test('runs the analysis and shows what it produced', async ({ page }) => {
    await reachAnalysis(page);

    await expect(page.getByText(/Nothing is sent to an outside service/)).toBeVisible();

    await page.getByRole('button', { name: 'Analyse my requirements' }).click();

    // A local model takes minutes on CPU; the deterministic provider takes
    // milliseconds. Either way the screen has to reach a finished state.
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    await expect(requirementsPanel(page)).toBeVisible();
    await expect(requirementsPanel(page).getByText('REQ-001')).toBeVisible();
  });

  test('every requirement can be checked against the words it came from', async ({ page }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    // The whole point of traceability: a reviewer can open the source without
    // leaving the screen and see the sentence the requirement came from.
    await requirementsPanel(page)
      .getByRole('button', { name: /^Source \(/ })
      .first()
      .click();

    await expect(
      requirementsPanel(page)
        .getByText(/Found in the document|Not found in the document/)
        .first(),
    ).toBeVisible();
  });

  test('the two confidences are shown apart, and the model’s is labelled', async ({ page }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    // The model's number is present and marked as an opinion.
    await expect(requirementsPanel(page).getByText('AI self-assessment').first()).toBeVisible();
    await expect(
      requirementsPanel(page)
        .getByText(/not a probability/i)
        .first(),
    ).toBeVisible();

    // The evidence score explains itself on request.
    await requirementsPanel(page).getByRole('button', { name: /Why\?/ }).first().click();
    await expect(requirementsPanel(page).getByText(/not by the AI model/i)).toBeVisible();
  });

  test('nothing is decided for the user', async ({ page }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    const panel = findingsPanel(page);

    await expect(panel).toBeVisible();

    /*
     * The panel says one of two honest things, and never a third. With findings
     * it states that none of them have been decided for the user; with none it
     * says so. What it must never do is offer a way to dispose of them in bulk —
     * every one of these decisions destroys information if made wrongly, and a
     * bulk control is an invitation to make it wrongly at scale.
     */
    await expect(
      panel.getByText(/None of these are decided for you|Nothing is outstanding/),
    ).toBeVisible();

    await expect(
      panel.getByRole('button', { name: /resolve all|dismiss all|merge all/i }),
    ).toHaveCount(0);
  });

  test('the baseline refuses approval while a blocker remains, and says which', async ({
    page,
  }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'Baseline approval' }).click();

    await expect(baselinePanel(page)).toBeVisible();
    // Shown with the baseline, not in a footer.
    await expect(baselinePanel(page).getByText(/Drafted by a self-hosted AI model/)).toBeVisible();

    const blockers = page.getByRole('heading', { name: /Before you can approve/ });

    if (await blockers.isVisible()) {
      // Disabled, and the reason is on the screen above it.
      await expect(page.getByRole('button', { name: 'Approve this baseline' })).toBeDisabled();
      await expect(
        page.getByText('Approval is unavailable while anything above is outstanding.'),
      ).toBeVisible();
    }
  });

  test('the baseline never claims completeness it has not earned', async ({ page }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'Baseline approval' }).click();

    await expect(baselinePanel(page).getByText('Alignment with your documents')).toBeVisible();
    await expect(baselinePanel(page).getByText('Documents accounted for')).toBeVisible();
  });

  test('clarification answers must be marked as fact or assumption', async ({ page }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'Clarifications' }).click();
    await expect(clarificationsPanel(page)).toBeVisible();

    const questions = page.getByRole('group', { name: 'Where does this answer come from?' });

    if ((await questions.count()) > 0) {
      // Neither option is pre-selected. The application cannot know which is
      // true, and choosing for the user is the mistake this control prevents.
      await expect(questions.first().getByRole('radio', { checked: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Save the answer' }).first()).toBeDisabled();
    }
  });

  test('the analysis screens are accessible', async ({ page }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    await expectNoAccessibilityViolations(page);

    await page.getByRole('button', { name: 'Baseline approval' }).click();
    await expect(baselinePanel(page)).toBeVisible();
    await expectNoAccessibilityViolations(page);

    await page.getByRole('button', { name: 'Clarifications' }).click();
    await expect(clarificationsPanel(page)).toBeVisible();
    await expectNoAccessibilityViolations(page);
  });
});

test.describe('Requirement analysis on a small screen', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the workflow stays usable on a phone', async ({ page }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    // Nothing scrolls sideways: the most common responsive regression, and the
    // one a desktop-only check never catches.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );

    expect(overflow).toBe(false);
    await expect(requirementsPanel(page).getByText('REQ-001')).toBeVisible();
  });
});
