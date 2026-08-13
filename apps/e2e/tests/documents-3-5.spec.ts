import { expect, test, type Page } from '@playwright/test';

import { DOCUMENT_LABELS } from '@wdrg/contracts';

import { expectNoAccessibilityViolations } from './support/accessibility';
import { createProject, enterWorkspace, saveSection, section } from './support/workspace';

/**
 * Acceptance Criteria, Assumptions and the Statement of Work, through a browser.
 *
 * The API runs deterministically, so what is under test is the interface: whether a
 * reviewer can tell a suggestion from an assumption, whether the sequence is visibly
 * a sequence, and whether the commercial document shows what it is quoting.
 *
 * The important assertions are the negative ones. A candidate assumption never reads
 * as agreed, the technology section never names something outside the locked stack,
 * and the timeline never shows a date nobody approved.
 */

const documentsPanel = (page: Page) => page.getByRole('region', { name: 'Documents', exact: true });
const criteriaPanel = (page: Page) =>
  page.getByRole('region', { name: 'Acceptance criteria', exact: true });
const assumptionsPanel = (page: Page) =>
  page.getByRole('region', { name: 'Assumptions', exact: true });
const contentPanel = (page: Page) => page.getByRole('region', { name: 'Document content' });
const validationPanel = (page: Page) => page.getByRole('region', { name: 'Document validation' });

const BRIEF = [
  'Staff must sign in and record their weekly timesheets on a weekly grid screen.',
  'A manager must approve every timesheet before it is exported.',
  'The system must keep a history of every approval.',
].join('\n');

/** A project sitting on the documents step, with everything upstream approved. */
async function reachDocuments(page: Page): Promise<void> {
  await page.goto('/');
  await createProject(page, { name: 'Documents 3 to 5' });
  await enterWorkspace(page);

  const details = section(page, 'details');
  await details.getByRole('checkbox', { name: 'Web application', exact: true }).check();
  await saveSection(page, 'details');

  const timeline = section(page, 'timeline');
  await timeline.getByRole('radio', { name: 'Weeks', exact: true }).check();
  await timeline.getByRole('spinbutton').fill('12');
  await saveSection(page, 'timeline');

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

  /* An estimate, run deterministically and approved. */
  await page.getByRole('button', { name: 'Estimation & timeline' }).click();
  await page.getByRole('button', { name: 'Estimate without AI' }).click();
  await expect(page.getByRole('region', { name: 'Effort', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('checkbox', { name: /I have read this estimate/ }).check();
  await page.getByRole('button', { name: 'Approve this estimate' }).click();
  await expect(page.getByTestId('estimate-status')).toHaveText('Approved', { timeout: 30_000 });

  await page.getByRole('button', { name: 'Document generation' }).click();
  await expect(documentsPanel(page)).toBeVisible();
}

/** Generate, validate and approve whichever document is open. */
async function settleOpenDocument(page: Page): Promise<void> {
  await page.getByTestId('validate-document').click();
  await expect(page.getByTestId('validation-severity')).toHaveText(/PASS|WARNING/, {
    timeout: 60_000,
  });
  await page.getByTestId('approve-document').click();
  await expect(page.getByTestId('detail-status')).toHaveText('Approved', { timeout: 60_000 });
}

/**
 * Open a document, waiting for it to be unlocked first.
 *
 * If it stays locked the assertion reports the lock's own sentence, which names the
 * prerequisite — far more use than a click timing out against a disabled button.
 */
async function openDocument(page: Page, type: string): Promise<void> {
  await expect(page.getByTestId(`document-open-${type}`)).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId(`document-open-${type}`).click();

  /*
   * Wait for the pane to be showing *this* document, by name.
   *
   * Not merely for a pane to exist: the previous document's is already on screen, so
   * a `toBeVisible` passes instantly and the next click lands on the wrong document.
   */
  await expect(page.getByTestId('detail-title')).toHaveText(
    DOCUMENT_LABELS[type as keyof typeof DOCUMENT_LABELS],
    { timeout: 30_000 },
  );
}

/**
 * Open a document, write it deterministically, then approve it.
 *
 * The list and the open document are both on screen, so moving on is a matter of
 * opening the next one — there is nothing to go back to.
 */
async function settle(page: Page, type: string): Promise<void> {
  /* Unlocked, because this is about to write it — not merely open it. */
  await expect(page.getByTestId(`document-lock-${type}`)).toBeHidden({ timeout: 60_000 });
  await openDocument(page, type);
  await page.getByTestId('generate-without-ai').click();

  /*
   * Wait for the document to exist, not for a version number.
   *
   * A document that has not been written yet is described honestly but still reports a
   * version — the version it would be written as — so waiting for "v1" was satisfied the
   * instant it ran, and validation then went out while the generation was still in
   * flight. Leaving "Not started" is the first thing that is only true afterwards.
   */
  await expect(page.getByTestId('detail-status')).not.toHaveText('Not started', {
    timeout: 90_000,
  });
  await settleOpenDocument(page);
}

/*
 * These walk the whole chain — requirements, analysis, baseline, stack, estimate and
 * up to five documents — so the default per-test budget is not enough. The work is
 * the point: a document is the end of the chain and the approvals cannot be skipped.
 */
test.describe.configure({ timeout: 420_000 });

test.describe('Documents 3 to 5', () => {
  /* 1, 2, 3. */
  test('shows the sequence, with each document locked behind the one before it', async ({
    page,
  }) => {
    await reachDocuments(page);

    /* All seven, in order, with the last two unavailable. */
    for (const [type, order] of [
      ['OUR_UNDERSTANDING', 1],
      ['FEATURE_LISTING', 2],
      ['ACCEPTANCE_CRITERIA', 3],
      ['ASSUMPTIONS', 4],
      ['STATEMENT_OF_WORK', 5],
      ['WORK_BREAKDOWN_STRUCTURE', 6],
      ['CLIENT_DEPENDENCY_SHEET', 7],
    ] as const) {
      await expect(page.getByTestId(`document-card-${type}`)).toContainText(`${order}.`);
    }

    /*
     * Phase 9 built the last two, so they are on the list as real documents held shut
     * by the sequence rather than as "not available yet" — and the Open button is
     * present but disabled while there is no version to read.
     */
    for (const type of ['WORK_BREAKDOWN_STRUCTURE', 'CLIENT_DEPENDENCY_SHEET']) {
      await expect(page.getByTestId(`document-unavailable-${type}`)).toBeHidden();
      await expect(page.getByTestId(`document-lock-${type}`)).toContainText('Approve');
      await expect(page.getByTestId(`document-open-${type}`)).toBeDisabled();
    }

    /* 3. And the three this phase adds are locked behind their prerequisites. */
    for (const type of ['ACCEPTANCE_CRITERIA', 'ASSUMPTIONS', 'STATEMENT_OF_WORK']) {
      await expect(page.getByTestId(`document-lock-${type}`)).toContainText('Approve');
    }

    await settle(page, 'OUR_UNDERSTANDING');
    await settle(page, 'FEATURE_LISTING');

    /* 2. Acceptance Criteria opens once the Feature Listing is approved. */
    await expect(page.getByTestId('document-lock-ACCEPTANCE_CRITERIA')).toBeHidden();
    await expect(page.getByTestId('document-open-ACCEPTANCE_CRITERIA')).toBeEnabled();
    /* 3. And the two after it are still shut. */
    await expect(page.getByTestId('document-lock-ASSUMPTIONS')).toContainText('Approve');
    await expect(page.getByTestId('document-lock-STATEMENT_OF_WORK')).toContainText('Approve');
  });

  /* 4, 5, 6, 7, 8, 9, 10. */
  test('writes acceptance criteria, and protects the ones a person edits', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');
    await settle(page, 'FEATURE_LISTING');

    /* 4. */
    await openDocument(page, 'ACCEPTANCE_CRITERIA');
    await page.getByTestId('generate-without-ai').click();
    await expect(criteriaPanel(page)).toBeVisible({ timeout: 90_000 });

    /* 5. Each condition reads as a condition, with what it is built on. */
    const first = page.getByTestId('criterion-AC-001');
    await expect(first).toBeVisible();
    await expect(page.getByTestId('criterion-text-AC-001')).toContainText(/Then|\w/);

    await page.getByTestId('criterion-sources-AC-001').click();
    await expect(page.getByTestId('criterion-sources-AC-001')).toContainText(/REQ-\d{3}/);

    /* 9. Coverage is stated as a fact. */
    await expect(page.getByTestId('criteria-coverage')).toContainText(/requirements/);

    /* 6. Edit one. */
    await page.getByTestId('criterion-edit-AC-001').click();
    await page
      .getByTestId('criterion-input-AC-001')
      .fill('The submitted timesheet appears in the approval list, in my words.');
    await page.getByTestId('criterion-save-AC-001').click();
    await expect(page.getByTestId('criterion-text-AC-001')).toContainText('in my words');

    /* 7, 8. Rewriting the document proposes rather than replacing it. */
    await page.getByTestId('generate-without-ai').click();
    await expect(page.getByTestId('document-version')).toHaveText('v2', { timeout: 90_000 });

    const proposal = criteriaPanel(page).locator('[data-testid^="criterion-proposal-"]').first();
    await expect(proposal).toBeVisible();
    await expect(criteriaPanel(page).getByText('in my words')).toBeVisible();

    /* The decision is the reviewer's, and keeping their words is one option. */
    await proposal.getByRole('button', { name: 'Keep mine' }).click();
    await expect(criteriaPanel(page).getByText('in my words')).toBeVisible();

    /* 10. And then it approves. */
    await settleOpenDocument(page);
  });

  /* 11, 12, 13, 14, 15, 16. */
  test('keeps a suggested assumption a suggestion until somebody stands behind it', async ({
    page,
  }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');
    await settle(page, 'FEATURE_LISTING');
    await settle(page, 'ACCEPTANCE_CRITERIA');

    /* 11. */
    await openDocument(page, 'ASSUMPTIONS');
    await page.getByTestId('generate-without-ai').click();
    await expect(assumptionsPanel(page)).toBeVisible({ timeout: 90_000 });

    /*
     * 15. Nobody flagged an assumption, so there are none — and the screen says
     * that is an answer rather than prompting for inventions.
     */
    await expect(page.getByTestId('assumption-summary')).toContainText(
      'Nothing has been recorded as an assumption',
    );
    await expect(page.getByTestId('assumptions-empty')).toContainText(
      'a complete answer, not a gap',
    );

    /* 16. And an empty document is approvable, because it is correct. */
    await settleOpenDocument(page);
  });

  /* 17, 18, 19, 20, 21, 22, 25, 26. */
  test('writes a statement of work that quotes the stack, the timeline and the criteria', async ({
    page,
  }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');
    await settle(page, 'FEATURE_LISTING');
    await settle(page, 'ACCEPTANCE_CRITERIA');
    await settle(page, 'ASSUMPTIONS');

    /* 17, 18. */
    await openDocument(page, 'STATEMENT_OF_WORK');
    await page.getByTestId('generate-without-ai').click();
    await expect(contentPanel(page)).toBeVisible({ timeout: 90_000 });

    /* 19. The locked stack, name for name, and nothing else. */
    const technology = page.getByTestId('section-body-technology');
    await expect(technology).toContainText('NestJS');
    await expect(technology).not.toContainText('Angular');
    await expect(technology).not.toContainText('MySQL');

    /*
     * 20. Relative, and naming no date.
     *
     * The interface has no way to supply a team — Phase 6 exposes none — so this
     * walkthrough approves an estimate with recommended staffing and no schedule,
     * and the document states its duration in the only form that evidence allows.
     * The integration suite supplies a team through the API and asserts the
     * "approximately N working weeks" form precisely; asserting it here would be
     * asserting something the browser cannot reach.
     */
    const timeline = page.getByTestId('section-body-timeline');
    await expect(timeline).toContainText('following the agreed project commencement');
    await expect(timeline).toContainText(
      /approximately \d+ working|duration set out in the approved estimate/,
    );
    await expect(timeline).not.toContainText(/\d{4}-\d{2}-\d{2}/);
    await expect(timeline).not.toContainText(/\bQ[1-4]\s*\d{4}\b/);

    /* 22. Acceptance points at the approved criteria rather than restating them. */
    await expect(page.getByTestId('section-body-acceptance')).toContainText('Acceptance Criteria');

    /* 21. The assumptions section says what it has, honestly. */
    await expect(page.getByTestId('section-assumptions')).toBeVisible();

    /* 26. Nothing about how the work is built, and no invented terms. */
    const everything = await contentPanel(page).innerText();
    for (const forbidden of [
      /governing law/i,
      /indemnif/i,
      /payment terms/i,
      /vibe cod/i,
      /AI[- ]assisted/i,
      /\bqwen/i,
      /language model/i,
    ]) {
      expect(everything).not.toMatch(forbidden);
    }

    /* And the missing commercial terms are named as missing. */
    await expect(page.getByTestId('section-body-commercial-terms')).toContainText(
      'have not been provided',
    );

    /* 23, 24. Edit one section, then rewrite another. */
    await page.getByTestId('section-edit-objective').click();
    await page
      .getByTestId('section-input-objective')
      .fill('Replace the spreadsheet process with a system staff can rely on.');
    await page.getByTestId('section-save-objective').click();
    await expect(page.getByTestId('section-body-objective')).toContainText('spreadsheet process');

    /*
     * Rewriting one section cuts a new document version, as any content change now does,
     * and takes the document back to draft. What matters here is that it left the section
     * somebody edited alone.
     *
     * The new version is also the only reliable sign that the rewrite has landed. Waiting
     * on the status does not work: the edit above already took the document to draft, so
     * that assertion passes instantly and the next step runs while the rewrite is still in
     * flight — which is how this test came to press Validate mid-request.
     */
    const beforeRewrite = await page.getByTestId('document-version').textContent();

    await page.getByTestId('section-regenerate-scope-of-work').click();
    await expect(page.getByTestId('document-version')).not.toHaveText(beforeRewrite ?? '', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('detail-status')).toHaveText('Draft', { timeout: 60_000 });
    await expect(page.getByTestId('section-body-objective')).toContainText('spreadsheet process');

    /* 25, 27. */
    await settleOpenDocument(page);
  });

  /* 28, 29, 30. */
  test('reports the whole chain as out of date when the requirements move', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');
    await settle(page, 'FEATURE_LISTING');
    await settle(page, 'ACCEPTANCE_CRITERIA');
    await settle(page, 'ASSUMPTIONS');
    await settle(page, 'STATEMENT_OF_WORK');

    /* Something upstream moves. */
    await page.getByRole('button', { name: 'Back to requirement input' }).click();

    const paste = page.getByRole('region', { name: 'Paste requirement text', exact: true });
    await paste.getByRole('textbox', { name: /Source title/ }).fill('Late addition');
    await paste
      .getByRole('textbox', { name: /Requirement text/ })
      .fill('Timesheets must be exportable as PDF.');
    await paste.getByRole('button', { name: 'Add requirement text' }).click();

    const sources = page.getByRole('region', { name: 'Requirement sources', exact: true });
    const row = sources.getByRole('listitem').filter({ hasText: 'Late addition' });
    await expect(row.getByText(/Ready|Needs your review/)).toBeVisible({ timeout: 60_000 });
    await sources.getByRole('button', { name: 'Late addition' }).click();

    const review = page.getByRole('region', { name: 'Extraction review', exact: true });
    await review.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(review.getByRole('button', { name: 'Reviewed' })).toBeDisabled();

    await page.getByRole('button', { name: 'Continue to requirement analysis' }).click();
    await page.getByRole('button', { name: 'Document generation' }).click();

    /* 30. Every document in the chain says it, and none of them changed. */
    for (const type of [
      'OUR_UNDERSTANDING',
      'FEATURE_LISTING',
      'ACCEPTANCE_CRITERIA',
      'ASSUMPTIONS',
      'STATEMENT_OF_WORK',
    ]) {
      await expect(page.getByTestId(`document-outdated-${type}`)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId(`document-status-${type}`)).toHaveText('Approved');
    }
  });

  /* 31. */
  test('keeps an issued statement of work immutable and marks it out of date', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');
    await settle(page, 'FEATURE_LISTING');
    await settle(page, 'ACCEPTANCE_CRITERIA');
    await settle(page, 'ASSUMPTIONS');

    /* The prerequisite is approved and current, which is what unlocks the next one. */
    await expect(page.getByTestId('document-status-ASSUMPTIONS')).toHaveText('Approved');
    await expect(page.getByTestId('document-outdated-ASSUMPTIONS')).toBeHidden();

    await openDocument(page, 'STATEMENT_OF_WORK');
    await page.getByTestId('generate-without-ai').click();
    await expect(contentPanel(page)).toBeVisible({ timeout: 90_000 });
    await settleOpenDocument(page);

    await page.getByTestId('mark-final').click();
    await expect(page.getByTestId('detail-status')).toHaveText('Issued', { timeout: 60_000 });

    const issued = await page.getByTestId('section-body-technology').textContent();

    /* Nothing offers to change it. */
    await expect(page.getByTestId('section-edit-technology')).toBeHidden();
    await expect(page.getByTestId('approve-document')).toBeHidden();
    await expect(page.getByTestId('revise-document')).toBeVisible();

    /* Reopen the document it is built on, and it goes out of date without moving. */
    await openDocument(page, 'ASSUMPTIONS');
    await page.getByTestId('reopen-document').click();
    await expect(page.getByTestId('detail-status')).toHaveText('Needs changes', {
      timeout: 60_000,
    });

    await expect(page.getByTestId('document-status-STATEMENT_OF_WORK')).toHaveText('Issued');
    await expect(page.getByTestId('document-outdated-STATEMENT_OF_WORK')).toBeVisible();

    /*
     * The record stays reachable. Its prerequisite has been withdrawn, so the lock is
     * showing and nothing here may be written — but a document somebody may have to
     * produce must not disappear behind a disabled button at the moment its context
     * has become contentious.
     */
    await expect(page.getByTestId('document-lock-STATEMENT_OF_WORK')).toBeVisible();
    await expect(page.getByTestId('document-open-STATEMENT_OF_WORK')).toBeEnabled();

    await openDocument(page, 'STATEMENT_OF_WORK');
    await expect(page.getByTestId('detail-currentness')).toHaveText('Out of date');
    await expect(page.getByTestId('section-body-technology')).toHaveText(issued!.trim());
  });

  /* 33. Everything works with no model at all — every document above ran that way. */
  test('completes the three documents with AI switched off', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');
    await settle(page, 'FEATURE_LISTING');

    for (const type of ['ACCEPTANCE_CRITERIA', 'ASSUMPTIONS', 'STATEMENT_OF_WORK']) {
      await page.getByTestId(`document-open-${type}`).click();
      await page.getByTestId('generate-without-ai').click();
      await expect(page.getByTestId('document-version')).toHaveText('v1', { timeout: 90_000 });
      await settleOpenDocument(page);
      await expect(page.getByTestId('detail-status')).toHaveText('Approved');
    }
  });

  /* ------------------------------------------------- responsive and axe */

  test.describe('the new documents stay usable', () => {
    for (const [name, viewport] of [
      ['a phone', { width: 390, height: 844 }],
      ['a tablet', { width: 768, height: 1024 }],
      ['a desktop', { width: 1440, height: 900 }],
    ] as const) {
      test(`on ${name}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await reachDocuments(page);
        await settle(page, 'OUR_UNDERSTANDING');
        await settle(page, 'FEATURE_LISTING');

        await openDocument(page, 'ACCEPTANCE_CRITERIA');
        await page.getByTestId('generate-without-ai').click();
        await expect(criteriaPanel(page)).toBeVisible({ timeout: 90_000 });
        await expect(validationPanel(page)).toBeVisible();

        /* Nothing scrolls the page sideways, whatever the width. */
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);

        await expectNoAccessibilityViolations(page);
      });
    }
  });
});
