import { expect, test, type Page } from '@playwright/test';

import { DOCUMENT_LABELS, DOCUMENT_ROUTES } from '@wdrg/contracts';

import { expectNoAccessibilityViolations } from './support/accessibility';
import { mutate, read } from './support/api';
import { createProject, enterWorkspace, saveSection, section } from './support/workspace';

/**
 * The review workflow through a browser: edit, version, compare, restore, trace.
 *
 * What matters here is whether the *concepts* survive contact with a screen. A reviewer
 * has to be able to see that a document is approved but no longer current, tell what
 * changed between two versions, find the version that was issued, and understand that
 * restoring brings content forward rather than rewinding. Each of those is a place where
 * a correct backend can still leave somebody with the wrong idea.
 */

const documentsPanel = (page: Page) => page.getByRole('region', { name: 'Documents', exact: true });
const versionsPanel = (page: Page) => page.getByRole('region', { name: 'Document versions' });
const tracePanel = (page: Page) => page.getByRole('region', { name: 'Traceability' });
const contentPanel = (page: Page) => page.getByRole('region', { name: 'Document content' });

const BRIEF = [
  'Staff must sign in and record their weekly timesheets on a weekly grid screen.',
  'A manager must approve every timesheet before it is exported.',
  'The system must keep a history of every approval.',
].join('\n');

/** A project sitting on the documents step with everything upstream approved. */
async function reachDocuments(page: Page): Promise<void> {
  await page.goto('/');
  await createProject(page, { name: 'Document lifecycle' });
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

/** Open a document, waiting for the pane to show *this* one. Idempotent. */
async function openDocument(page: Page, type: string): Promise<void> {
  const title = DOCUMENT_LABELS[type as keyof typeof DOCUMENT_LABELS];

  if (await page.getByTestId('detail-title').filter({ hasText: title }).count()) {
    return;
  }

  await expect(page.getByTestId(`document-open-${type}`)).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId(`document-open-${type}`).click();
  await expect(page.getByTestId('detail-title')).toHaveText(title, { timeout: 30_000 });
}

async function settleOpenDocument(page: Page): Promise<void> {
  await page.getByTestId('validate-document').click();
  await expect(page.getByTestId('validation-severity')).toHaveText(/PASS|WARNING/, {
    timeout: 60_000,
  });
  await page.getByTestId('approve-document').click();
  await expect(page.getByTestId('detail-status')).toHaveText('Approved', { timeout: 60_000 });
}

async function settle(page: Page, type: string): Promise<void> {
  await openDocument(page, type);
  await page.getByTestId('generate-without-ai').click();
  await expect(page.getByTestId('document-version')).toHaveText(/v\d+/, { timeout: 90_000 });
  await settleOpenDocument(page);
}

/**
 * Edit the first section of the open document and wait for the version to move.
 *
 * The section key is read off the pane rather than hard-coded, so this works for any
 * document — and the wait is on the version changing, which is the observable effect of
 * a content change under Phase 10.
 */
async function editFirstSection(page: Page, text: string): Promise<string> {
  const before = (await page.getByTestId('document-version').textContent()) ?? '';

  const editButton = contentPanel(page).locator('[data-testid^="section-edit-"]').first();

  const key = (await editButton.getAttribute('data-testid'))!.replace('section-edit-', '');

  await editButton.click();
  await page.getByTestId(`section-input-${key}`).fill(text);
  await page.getByTestId(`section-save-${key}`).click();

  await expect(page.getByTestId('document-version')).not.toHaveText(before, { timeout: 60_000 });

  return key;
}

/*
 * The whole chain plus several documents and a version history, so the default
 * per-test budget is nowhere near enough.
 */
test.describe.configure({ timeout: 600_000 });

test.describe('Document lifecycle', () => {
  /* 1, 2, 3, 4, 5. */
  test('edits a section, cuts a version, and compares before and after', async ({ page }) => {
    await reachDocuments(page);
    await openDocument(page, 'OUR_UNDERSTANDING');
    await page.getByTestId('generate-without-ai').click();
    await expect(contentPanel(page)).toBeVisible({ timeout: 90_000 });

    /* 1, 2. The history is on screen, and says what the current version is. */
    await expect(versionsPanel(page)).toBeVisible();
    await expect(versionsPanel(page).getByTestId('version-list')).toBeVisible();
    await expect(versionsPanel(page).getByText(/— current/)).toBeVisible();

    /* 3, 4. An edit, and a new version for it. */
    await editFirstSection(page, 'A deliberately reworded opening, for the comparison.');

    /* Each version says what produced it, rather than only when it happened. */
    await expect(versionsPanel(page).getByText('A section edited').first()).toBeVisible({
      timeout: 30_000,
    });

    /* 5. Comparing the two shows the change. */
    const rows = versionsPanel(page).getByTestId('version-list').getByRole('listitem');
    await expect(rows).toHaveCount(2, { timeout: 30_000 });

    await rows.nth(1).getByRole('button', { name: 'Compare from' }).click();
    await rows.nth(0).getByRole('button', { name: 'Compare to' }).click();

    await expect(versionsPanel(page).getByTestId('version-diff')).toBeVisible();
    await expect(versionsPanel(page).getByText(/deliberately reworded opening/)).toBeVisible({
      timeout: 30_000,
    });
  });

  /* 6, 7, 8, 9. */
  test('edits, adds and removes an entry, and shows the row differences', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');
    await settle(page, 'FEATURE_LISTING');

    await openDocument(page, 'ACCEPTANCE_CRITERIA');
    await page.getByTestId('generate-without-ai').click();

    const criteria = page.getByRole('region', { name: 'Acceptance criteria', exact: true });
    await expect(criteria).toBeVisible({ timeout: 90_000 });

    const versionBefore = await page.getByTestId('document-version').textContent();

    /* 6. Edit a row. */
    await criteria.locator('[data-testid^="criterion-edit-"]').first().click();
    await criteria
      .locator('[data-testid^="criterion-input-"]')
      .first()
      .fill('Reviewed with the delivery lead.');
    await criteria.locator('[data-testid^="criterion-save-"]').first().click();

    /* 7. Which cuts a version. */
    await expect(page.getByTestId('document-version')).not.toHaveText(versionBefore ?? '', {
      timeout: 60_000,
    });

    /* 8, 9. And the comparison names the field that changed, not just the row. */
    const rows = versionsPanel(page).getByTestId('version-list').getByRole('listitem');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });

    await rows.nth(1).getByRole('button', { name: 'Compare from' }).click();
    await rows.nth(0).getByRole('button', { name: 'Compare to' }).click();

    await expect(versionsPanel(page).getByTestId('version-diff')).toBeVisible();
    await expect(
      versionsPanel(page)
        .getByText(/An entry edited/)
        .first(),
    ).toBeVisible({
      timeout: 30_000,
    });
  });

  /* 10, 11, 12, 13, 14, 15. */
  test('reopens an approved document, and approval no longer applies to the change', async ({
    page,
  }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');

    /* 10. Reopen. */
    await page.getByTestId('document-reason').fill('The summary needs more detail.');
    await page.getByTestId('reopen-document').click();

    await expect(page.getByTestId('detail-status')).toHaveText('Needs changes', {
      timeout: 60_000,
    });

    /* The approved version is still in the history, marked as approved. */
    await expect(versionsPanel(page).getByText('Approved').first()).toBeVisible();

    /* 11. Edit it: what is on screen is no longer what was approved. */
    await editFirstSection(page, 'A fuller summary, not yet approved by anybody.');

    await expect(page.getByTestId('detail-status')).not.toHaveText('Approved');

    /* 12, 13. Validate and approve again. */
    await settleOpenDocument(page);
    await expect(page.getByTestId('detail-status')).toHaveText('Approved');

    /* 14. Issue it. */
    await page.getByTestId('mark-final').click();
    await expect(page.getByTestId('detail-status')).toHaveText('Issued', { timeout: 60_000 });

    /* 15. Which is read-only: nothing offers to change it. */
    await expect(contentPanel(page).locator('[data-testid^="section-edit-"]')).toHaveCount(0);
  });

  /* 16, 17, 18, 19. */
  test('revises an issued document and restores an earlier version', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');

    await page.getByTestId('mark-final').click();
    await expect(page.getByTestId('detail-status')).toHaveText('Issued', { timeout: 60_000 });

    const issued = await contentPanel(page)
      .locator('[data-testid^="section-body-"]')
      .first()
      .textContent();

    /* 16. A revision beside the issued version. */
    await page.getByTestId('document-reason').fill('A second issue is needed.');
    await page.getByTestId('revise-document').click();

    await expect(page.getByTestId('detail-status')).toHaveText('Draft', { timeout: 60_000 });

    /* 17. The issued version is still there, still marked as issued. */
    await expect(versionsPanel(page).getByText('Issued').first()).toBeVisible();

    await editFirstSection(page, 'Wording for the second issue.');

    /* 18. Restore the issued content into a new working version. */
    const rows = versionsPanel(page).getByTestId('version-list').getByRole('listitem');
    const restoreButtons = rows.getByRole('button', { name: 'Restore this one' });

    await restoreButtons.last().click();

    /* 19. Which needs review again — a restored version is not an approved one. */
    await expect(page.getByTestId('detail-status')).toHaveText(/Draft|Needs changes/, {
      timeout: 60_000,
    });

    await expect(
      versionsPanel(page)
        .getByText(/Content brought back from an earlier version/)
        .first(),
    ).toBeVisible({ timeout: 30_000 });

    /* And the issued text is what came back. */
    if (issued) {
      await expect(contentPanel(page).getByText(issued.slice(0, 40))).toBeVisible({
        timeout: 30_000,
      });
    }
  });

  /* 20, 21, 22, 23. */
  test('protects an edit through a regeneration and offers a proposal', async ({ page }) => {
    await reachDocuments(page);
    await openDocument(page, 'OUR_UNDERSTANDING');
    await page.getByTestId('generate-without-ai').click();
    await expect(contentPanel(page)).toBeVisible({ timeout: 90_000 });

    /* 20. A protected edit. */
    await editFirstSection(page, 'Wording a person chose and expects to keep.');

    /* 21. Regenerate the whole document. */
    await page.getByTestId('generate-without-ai').click();
    await expect(page.getByTestId('document-version')).toHaveText(/v\d+/, { timeout: 90_000 });

    /* 22. The edit survives, and the new text waits as a proposal. */
    await expect(
      contentPanel(page).getByText('Wording a person chose and expects to keep.'),
    ).toBeVisible({
      timeout: 30_000,
    });

    await expect(
      contentPanel(page).locator('[data-testid^="section-proposal-"]').first(),
    ).toBeVisible({ timeout: 30_000 });

    /* 23. And the reviewer decides, rather than the rewrite being applied for them. */
    await expect(
      contentPanel(page).locator('[data-testid^="proposal-KEEP_CURRENT-"]').first(),
    ).toBeVisible();
  });

  /* 24, 25, 26, 27, 28, 29, 30, 31. */
  test('shows a downstream document as approved but out of date, and why', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');
    await settle(page, 'FEATURE_LISTING');
    await settle(page, 'ACCEPTANCE_CRITERIA');

    /*
     * The entries themselves, not the whole panel. The panel also carries the coverage
     * assessment, which legitimately changes when the Feature Listing stops being
     * authoritative — there is then nothing to measure against. The *content* is what
     * must not move.
     */
    const criteriaRows = () =>
      page
        .getByRole('region', { name: 'Acceptance criteria', exact: true })
        .locator('[data-testid^="criterion-AC-"]')
        .allTextContents();

    const criteriaContent = await criteriaRows();

    /* 26. Change something upstream. */
    await openDocument(page, 'FEATURE_LISTING');
    await page.getByTestId('document-reason').fill('Revising the agreed features.');
    await page.getByTestId('reopen-document').click();
    await expect(page.getByTestId('detail-status')).toHaveText('Needs changes', {
      timeout: 60_000,
    });

    /* 27, 28. The downstream document is approved *and* out of date, with a reason. */
    await openDocument(page, 'ACCEPTANCE_CRITERIA');

    await expect(page.getByTestId('detail-status')).toHaveText('Approved');
    await expect(page.getByTestId('outdated-warning')).toBeVisible();
    await expect(page.getByTestId('outdated-warning')).not.toHaveText('Outdated');
    await expect(page.getByTestId('outdated-warning')).toContainText(/changed/);

    /* 29. And its content was not touched. */
    expect(await criteriaRows()).toEqual(criteriaContent);

    /* 30, 31. Reconciling it legitimately: approve upstream, then write this again. */
    await openDocument(page, 'FEATURE_LISTING');
    await settleOpenDocument(page);

    await openDocument(page, 'ACCEPTANCE_CRITERIA');
    await expect(page.getByTestId('outdated-warning')).toBeVisible();

    await page.getByTestId('generate-without-ai').click();
    await expect(page.getByTestId('document-version')).toHaveText(/v\d+/, { timeout: 90_000 });
    await expect(page.getByTestId('outdated-warning')).toBeHidden({ timeout: 60_000 });
  });

  /* 32, 33, 34, 35, 36. */
  test('follows a requirement through the documents and back again', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING');
    await settle(page, 'FEATURE_LISTING');

    /* 32. The traceability view. */
    await expect(tracePanel(page)).toBeVisible({ timeout: 60_000 });
    await expect(tracePanel(page).getByTestId('trace-summary')).toContainText('requirement');

    /* 33. A requirement, expanded, shows where it appears. */
    const first = tracePanel(page).getByTestId('trace-requirements').getByRole('listitem').first();

    await first.getByRole('button', { name: /Where it appears|Hide/ }).click();

    await expect(first.getByText('Feature Listing').first()).toBeVisible({ timeout: 30_000 });

    /* 34. And clicking through opens that document. */
    await first.getByTestId('trace-open-FEATURE_LISTING').first().click();
    await expect(page.getByTestId('detail-title')).toHaveText('Feature Listing', {
      timeout: 30_000,
    });

    /* 35, 36. The optional documents are marked as such, not as failures. */
    await expect(tracePanel(page).getByTestId('trace-coverage-ASSUMPTIONS')).toContainText(
      'Only where it applies',
    );
    await expect(
      tracePanel(page).getByTestId('trace-coverage-CLIENT_DEPENDENCY_SHEET'),
    ).toContainText('Only where it applies');
  });

  /* 37, 38, 39, 40. */
  test('explains a lost race rather than overwriting somebody else', async ({ page }) => {
    await reachDocuments(page);
    await openDocument(page, 'OUR_UNDERSTANDING');
    await page.getByTestId('generate-without-ai').click();
    await expect(contentPanel(page)).toBeVisible({ timeout: 90_000 });

    /*
     * Open the editor, then move the document on without telling the page.
     *
     * The change has to arrive from outside this page's knowledge, which is what makes
     * the save stale. Pressing Regenerate here would not do it: the page handles its own
     * response, re-renders on the new version and closes the editor, so there is no stale
     * save left to make. A second tab would be the truer picture of two people and is a
     * lot of machinery for the thing under test — a call on the same session, which is
     * what the other tab would be doing anyway, leaves the editor exactly where a person
     * left it.
     */
    const key = (await contentPanel(page)
      .locator('[data-testid^="section-edit-"]')
      .first()
      .getAttribute('data-testid'))!.replace('section-edit-', '');

    await contentPanel(page).locator(`[data-testid="section-edit-${key}"]`).click();
    await page.getByTestId(`section-input-${key}`).fill('My unsaved wording.');

    const before = await page.getByTestId('document-version').textContent();

    const current = await read(page.context(), DOCUMENT_ROUTES.document('OUR_UNDERSTANDING'));
    const snapshot = (await current.json()) as { document: { recordVersion: number } };

    const moved = await mutate(
      page.context(),
      'POST',
      DOCUMENT_ROUTES.generate('OUR_UNDERSTANDING'),
      {
        useAi: false,
        reason: 'Rewritten by somebody else while this editor was open.',
        expectedVersion: snapshot.document.recordVersion,
      },
    );

    expect(moved.status()).toBe(201);

    /* The page still shows the version it read, and still has the editor open. */
    await expect(page.getByTestId('document-version')).toHaveText(before ?? '');
    await expect(page.getByTestId(`section-input-${key}`)).toBeVisible();

    /* 37. Now save from what is now a stale read. */
    await page.getByTestId(`section-save-${key}`).click();

    /* 38. Which is explained as a conflict rather than as a generic failure. */
    await expect(page.getByTestId('section-conflict')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('section-conflict')).toContainText(
      /changed while you were working/,
    );

    /* 39. And the text is still in the box: nothing of the user's was thrown away. */
    await expect(page.getByTestId(`section-input-${key}`)).toHaveValue('My unsaved wording.');

    /* 40. Reloading shows the version that won, and the editor is closed. */
    await page.reload();
    await openDocument(page, 'OUR_UNDERSTANDING');

    await expect(contentPanel(page).locator(`[data-testid="section-body-${key}"]`)).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      contentPanel(page).locator(`[data-testid="section-body-${key}"]`),
    ).not.toContainText('My unsaved wording.');
  });

  /* ------------------------------------------------- responsive and axe */

  test.describe('the review workspace stays usable', () => {
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

        await openDocument(page, 'OUR_UNDERSTANDING');
        await editFirstSection(page, 'Reworded so there is something to compare.');

        /* A comparison, which is the thing most likely to break on a narrow screen. */
        const rows = versionsPanel(page).getByTestId('version-list').getByRole('listitem');
        await rows.nth(1).getByRole('button', { name: 'Compare from' }).click();
        await rows.nth(0).getByRole('button', { name: 'Compare to' }).click();

        await expect(versionsPanel(page).getByTestId('version-diff')).toBeVisible({
          timeout: 30_000,
        });

        /* Old above new rather than side by side: the page never scrolls sideways. */
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );

        expect(overflow).toBeLessThanOrEqual(1);

        await expect(tracePanel(page)).toBeVisible({ timeout: 60_000 });

        await expectNoAccessibilityViolations(page);
      });
    }
  });
});
