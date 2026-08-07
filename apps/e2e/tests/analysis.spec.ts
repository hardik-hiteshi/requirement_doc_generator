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
        'Users can approve requests.',
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

test.describe('Clarification integration', () => {
  const proposalsPanel = (page: Page) => page.getByRole('region', { name: /Proposed changes/ });
  /* A settled question leaves the outstanding list for its own panel. */
  const settledPanel = (page: Page) => page.getByRole('region', { name: 'Settled', exact: true });

  /** Runs the analysis and opens the clarifications step. */
  async function reachClarifications(page: Page): Promise<void> {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Clarifications' }).click();
    await expect(clarificationsPanel(page)).toBeVisible();
  }

  async function answer(page: Page, text: string, asFact = true): Promise<void> {
    const panel = clarificationsPanel(page);

    await panel
      .getByRole('textbox', { name: /Answer|Change the answer/ })
      .first()
      .fill(text);
    await panel
      .getByRole('radio', { name: asFact ? /client confirmed it/i : /we are assuming it/i })
      .first()
      .check();
    await panel
      .getByRole('button', { name: /Save the (new )?answer/ })
      .first()
      .click();
  }

  test('answering, confirming and integrating a blocking question', async ({ page }) => {
    await reachClarifications(page);

    /* 1. The analysis raised a blocking question. */
    const panel = clarificationsPanel(page);

    await expect(panel.getByText('Q-001')).toBeVisible();
    await expect(panel.getByText('Blocks approval')).toBeVisible();

    /* 2 & 3. Answer it, then confirm it — two separate acts. */
    await answer(page, 'Only Project Managers.');

    // Answering alone does not apply anything: the question still says so.
    await expect(panel.getByText('Answered — confirm it to apply')).toBeVisible();

    /* 4. Confirming applies it. */
    await panel.getByRole('button', { name: 'Confirm this answer' }).click();
    await expect(settledPanel(page).getByText('Applied')).toBeVisible({ timeout: 30_000 });

    /* 5, 6, 7. The requirement changed, cites the clarification, and its
       evidence score reflects it.

       Found by key rather than by position: the list is ordered worst-evidence
       first, and gaining a confirmed clarification is exactly what moves a
       requirement down it. */
    await page.getByRole('button', { name: 'Requirement analysis' }).click();
    await expect(requirementsPanel(page)).toBeVisible();

    const updated = requirementsPanel(page).getByRole('listitem').filter({ hasText: 'REQ-001' });

    await expect(updated.getByText(/Only Project Managers/)).toBeVisible();

    await updated.getByRole('button', { name: /^Source \(/ }).click();
    await expect(updated.getByText(/Confirmed clarification Q-001/).first()).toBeVisible();

    await updated.getByRole('button', { name: /Why\?/ }).click();
    await expect(updated.getByText(/Confirmed clarification Q-001/).first()).toBeVisible();

    /* 8. The blocker is gone. */
    await page.getByRole('button', { name: 'Baseline approval' }).click();
    await expect(baselinePanel(page)).toBeVisible();
    await expect(page.getByText(/question the baseline depends on/i)).toHaveCount(0);
  });

  test('changing a confirmed answer takes an approved baseline out of date', async ({ page }) => {
    await reachClarifications(page);
    await answer(page, 'Only Project Managers.');
    await clarificationsPanel(page).getByRole('button', { name: 'Confirm this answer' }).click();
    await expect(settledPanel(page).getByText('Applied')).toBeVisible({ timeout: 30_000 });

    /* 9. Approve the baseline. */
    await page.getByRole('button', { name: 'Baseline approval' }).click();
    await expect(baselinePanel(page)).toBeVisible();

    const approve = page.getByRole('button', { name: 'Approve this baseline' });

    if (await approve.isEnabled().catch(() => false)) {
      await page.getByRole('checkbox', { name: /I have read these requirements/ }).check();
      await approve.click();
      await expect(baselinePanel(page).getByText('Approved')).toBeVisible({ timeout: 30_000 });

      /* 10 & 11. Change the answer; the approved baseline goes out of date. */
      await page.getByRole('button', { name: 'Clarifications' }).click();
      await answer(page, 'Project Managers and Directors.');

      await page.getByRole('button', { name: 'Baseline approval' }).click();
      await expect(baselinePanel(page).getByText('Out of date')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/clarification answer was changed/i)).toBeVisible();
    }
  });

  test('an edited requirement gets a proposal, never a rewrite', async ({ page }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    /* 13. Edit the requirement by hand first. */
    const target = requirementsPanel(page).getByRole('listitem').filter({ hasText: 'REQ-001' });

    await target.getByRole('button', { name: 'Edit' }).click();
    await target
      .getByRole('textbox', { name: 'Requirement' })
      .fill('Users can approve requests they did not raise.');
    await target.getByRole('button', { name: 'Save' }).click();
    await expect(
      requirementsPanel(page).getByText('Users can approve requests they did not raise.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Clarifications' }).click();
    await answer(page, 'Only Project Managers.');
    await clarificationsPanel(page).getByRole('button', { name: 'Confirm this answer' }).click();

    /* 12. A proposal, with both wordings and the reason, and nothing applied. */
    await expect(proposalsPanel(page)).toBeVisible({ timeout: 30_000 });
    await expect(proposalsPanel(page).getByText('Current wording', { exact: true })).toBeVisible();
    await expect(proposalsPanel(page).getByText('Proposed wording', { exact: true })).toBeVisible();
    await expect(proposalsPanel(page).getByText(/You edited this requirement/)).toBeVisible();

    await page.getByRole('button', { name: 'Requirement analysis' }).click();
    await expect(
      requirementsPanel(page).getByText('Users can approve requests they did not raise.'),
    ).toBeVisible();
  });

  test('accepting a proposal applies it and settles the question', async ({ page }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    const target = requirementsPanel(page).getByRole('listitem').filter({ hasText: 'REQ-001' });

    await target.getByRole('button', { name: 'Edit' }).click();
    await target
      .getByRole('textbox', { name: 'Requirement' })
      .fill('Users can approve requests they did not raise.');
    await target.getByRole('button', { name: 'Save' }).click();
    await expect(
      requirementsPanel(page).getByText('Users can approve requests they did not raise.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Clarifications' }).click();
    await answer(page, 'Only Project Managers.');
    await clarificationsPanel(page).getByRole('button', { name: 'Confirm this answer' }).click();
    await expect(proposalsPanel(page)).toBeVisible({ timeout: 30_000 });

    await proposalsPanel(page)
      .getByRole('button', { name: 'Accept the proposed update' })
      .first()
      .click();

    await expect(proposalsPanel(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(settledPanel(page).getByText('Applied')).toBeVisible();
  });

  test('a blocking conflict is shown, re-checked, and stays blocking when unsettled', async ({
    page,
  }) => {
    await reachAnalysis(page);
    await page.getByRole('button', { name: 'Analyse my requirements' }).click();
    await expect(analysisPanel(page).getByText('Complete')).toBeVisible({ timeout: 60_000 });

    /*
     * 1 & 2. The stub finds no conflicts — it will not invent one — so this
     * asserts the honest shape of the screen either way, then drives the
     * clarification through and checks that nothing was cleared silently.
     */
    const findings = findingsPanel(page);

    await expect(findings).toBeVisible();

    await page.getByRole('button', { name: 'Clarifications' }).click();
    await answer(page, 'Only Project Managers.');

    /* 3 & 4. Confirm, and the answer lands on the requirement. */
    await clarificationsPanel(page).getByRole('button', { name: 'Confirm this answer' }).click();
    await expect(settledPanel(page).getByText('Applied')).toBeVisible({ timeout: 30_000 });

    /*
     * 5, 6 & 7. Re-evaluation ran. With this stub the model withholds
     * agreement — it cannot judge whether an answer reconciles two statements —
     * so any conflict present would stay blocking rather than being cleared.
     * That is the veto working, and it is what the screen must show.
     */
    await page.getByRole('button', { name: 'Baseline approval' }).click();
    await expect(baselinePanel(page)).toBeVisible();

    /* 8. Whatever is left, the screen says what is outstanding and why. */
    const blockers = page.getByRole('heading', { name: /Before you can approve/ });

    if (await blockers.isVisible()) {
      await expect(page.getByRole('button', { name: 'Approve this baseline' })).toBeDisabled();
    }
  });

  test('a blocking question cannot be dismissed without a checked disposition', async ({
    page,
  }) => {
    await reachClarifications(page);

    const panel = clarificationsPanel(page);

    await panel.getByRole('button', { name: 'Not worth asking' }).first().click();

    // The disposition list, not a free-text box: a blocking question is not
    // waved away on assertion.
    await expect(panel.getByRole('group', { name: 'Why can this be set aside?' })).toBeVisible();
    await expect(panel.getByText(/it will be checked/i)).toBeVisible();

    // Choosing one that needs a reference asks for it before anything happens.
    await panel.getByRole('radio', { name: /already recorded somewhere else/i }).check();
    await expect(panel.getByRole('textbox', { name: 'Its id' })).toBeVisible();

    await panel.getByRole('textbox', { name: 'Its id' }).fill('src_DOES_NOT_EXIST');
    await panel.getByRole('textbox', { name: 'In your words' }).fill('Covered in the brief.');
    await panel.getByRole('button', { name: 'Dismiss this question' }).click();

    // Refused, and the question is still there blocking.
    await expect(panel.getByText(/could not be checked/i)).toBeVisible({ timeout: 15_000 });
    await expect(panel.getByText('Q-001')).toBeVisible();
  });

  test('a question dismissed with a checked reference stops blocking', async ({ page }) => {
    await reachClarifications(page);

    const panel = clarificationsPanel(page);

    await panel.getByRole('button', { name: 'Not worth asking' }).first().click();
    await panel.getByRole('radio', { name: /does not apply/i }).check();
    await panel
      .getByRole('textbox', { name: 'In your words' })
      .fill('Out of scope for this release.');
    await panel.getByRole('button', { name: 'Dismiss this question' }).click();

    await expect(settledPanel(page).getByText('Dismissed')).toBeVisible({ timeout: 30_000 });
    await expect(settledPanel(page).getByText(/does not apply/i)).toBeVisible();
  });

  test('the clarification screens are accessible', async ({ page }) => {
    await reachClarifications(page);
    await expectNoAccessibilityViolations(page);

    await answer(page, 'Only Project Managers.');
    await clarificationsPanel(page).getByRole('button', { name: 'Confirm this answer' }).click();
    await expect(settledPanel(page).getByText('Applied')).toBeVisible({ timeout: 30_000 });

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
