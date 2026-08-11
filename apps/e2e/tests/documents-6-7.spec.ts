import { expect, test, type Page } from '@playwright/test';

import { DOCUMENT_LABELS } from '@wdrg/contracts';

import { expectNoAccessibilityViolations } from './support/accessibility';
import { createProject, enterWorkspace, saveSection, section } from './support/workspace';

/**
 * The Work Breakdown Structure and the Client Dependency Sheet, through a browser.
 *
 * The API runs deterministically, so what is under test here is the interface, and two
 * things it has to get right.
 *
 * **The breakdown has to look like the approved plan.** So the reconciliation is
 * asserted on screen, the critical path is visible on the rows it belongs to, and
 * hand-editing a start day produces the message that names the estimation step rather
 * than a silent refusal.
 *
 * **The sheet has to keep "arrived" apart from "works".** A received item offers
 * *Check it*, not a tick; accepting requires a note; and the status a reader sees says
 * "Received, not checked" until somebody has looked.
 */

const documentsPanel = (page: Page) => page.getByRole('region', { name: 'Documents', exact: true });
const wbsPanel = (page: Page) =>
  page.getByRole('region', { name: 'Work breakdown structure', exact: true });
const dependencyPanel = (page: Page) =>
  page.getByRole('region', { name: 'Client dependency sheet', exact: true });
const validationPanel = (page: Page) => page.getByRole('region', { name: 'Document validation' });

/**
 * A brief with an integration in it.
 *
 * The payroll export is what makes the dependency sheet have something real to ask
 * for: an integration nobody has documentation for is the commonest genuine client
 * dependency there is.
 */
const BRIEF = [
  'Staff must sign in and record their weekly timesheets on a weekly grid screen.',
  'A manager must approve every timesheet before it is exported.',
  'Approved timesheet totals must be sent to Sage Payroll each month.',
  'The system must keep a history of every approval.',
].join('\n');

/** A project sitting on the documents step, with everything upstream approved. */
async function reachDocuments(page: Page): Promise<void> {
  await page.goto('/');
  await createProject(page, { name: 'Documents 6 and 7' });
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

async function settleOpenDocument(page: Page): Promise<void> {
  await page.getByTestId('validate-document').click();
  await expect(page.getByTestId('validation-severity')).toHaveText(/PASS|WARNING/, {
    timeout: 60_000,
  });
  await page.getByTestId('approve-document').click();
  await expect(page.getByTestId('detail-status')).toHaveText('Approved', { timeout: 60_000 });
}

/** Open a document, waiting for the pane to be showing *this* one, by name. */
async function openDocument(page: Page, type: string): Promise<void> {
  await expect(page.getByTestId(`document-open-${type}`)).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId(`document-open-${type}`).click();
  await expect(page.getByTestId('detail-title')).toHaveText(
    DOCUMENT_LABELS[type as keyof typeof DOCUMENT_LABELS],
    { timeout: 30_000 },
  );
}

async function settle(page: Page, type: string): Promise<void> {
  await expect(page.getByTestId(`document-lock-${type}`)).toBeHidden({ timeout: 60_000 });
  await openDocument(page, type);
  await page.getByTestId('generate-without-ai').click();
  await expect(page.getByTestId('document-version')).toHaveText('v1', { timeout: 90_000 });
  await settleOpenDocument(page);
}

/** Everything up to and including an approved Statement of Work. */
async function throughStatementOfWork(page: Page): Promise<void> {
  await reachDocuments(page);

  for (const type of [
    'OUR_UNDERSTANDING',
    'FEATURE_LISTING',
    'ACCEPTANCE_CRITERIA',
    'ASSUMPTIONS',
    'STATEMENT_OF_WORK',
  ]) {
    await settle(page, type);
  }
}

/** Everything up to and including an approved work breakdown. */
async function throughWbs(page: Page): Promise<void> {
  await throughStatementOfWork(page);
  await settle(page, 'WORK_BREAKDOWN_STRUCTURE');
}

/*
 * These walk the whole chain — requirements, analysis, baseline, stack, estimate and
 * seven documents — so the default per-test budget is nowhere near enough. The work is
 * the point: these are the last two documents, and nothing before them can be skipped.
 */
test.describe.configure({ timeout: 600_000 });

test.describe('Documents 6 and 7', () => {
  /* 1, 2, 3, 4. */
  test('shows both documents in sequence, each locked behind the one before it', async ({
    page,
  }) => {
    await reachDocuments(page);

    /* 1. Both are on the list, in order, as real documents. */
    await expect(page.getByTestId('document-card-WORK_BREAKDOWN_STRUCTURE')).toContainText('6.');
    await expect(page.getByTestId('document-card-CLIENT_DEPENDENCY_SHEET')).toContainText('7.');

    /* 2. Neither is marked unavailable any more — Phase 9 built them. */
    for (const type of ['WORK_BREAKDOWN_STRUCTURE', 'CLIENT_DEPENDENCY_SHEET']) {
      await expect(page.getByTestId(`document-unavailable-${type}`)).toBeHidden();
    }

    /* 3, 4. Each says which step it is waiting for, and cannot be opened yet. */
    for (const type of ['WORK_BREAKDOWN_STRUCTURE', 'CLIENT_DEPENDENCY_SHEET']) {
      await expect(page.getByTestId(`document-lock-${type}`)).toContainText('Approve');
      await expect(page.getByTestId(`document-open-${type}`)).toBeDisabled();
    }
  });

  /* 5, 6, 7, 8, 9, 10. */
  test('writes the work breakdown as the approved plan, and says so', async ({ page }) => {
    await throughStatementOfWork(page);

    /* 5. Unlocked by the approved statement of work. */
    await expect(page.getByTestId('document-lock-WORK_BREAKDOWN_STRUCTURE')).toBeHidden({
      timeout: 60_000,
    });

    await openDocument(page, 'WORK_BREAKDOWN_STRUCTURE');
    await page.getByTestId('generate-without-ai').click();
    await expect(wbsPanel(page)).toBeVisible({ timeout: 90_000 });

    /* 6. The reconciliation is on screen, and it agrees with the estimate. */
    await expect(wbsPanel(page).getByTestId('wbs-reconciliation')).toBeVisible();
    await expect(wbsPanel(page).getByTestId('wbs-reconciled')).toBeVisible();
    await expect(wbsPanel(page).getByTestId('wbs-not-reconciled')).toBeHidden();

    /* 7. The hierarchy is there: a project row, and tasks beneath it. */
    await expect(wbsPanel(page).getByTestId('wbs-row-1')).toBeVisible();
    await expect(
      wbsPanel(page).getByTestId('wbs-rows').getByRole('listitem').first(),
    ).toBeVisible();

    /* 8. Hours are shown against the rows. */
    await expect(wbsPanel(page).getByTestId('wbs-hours-1')).toContainText('h');

    /* 9. The critical path is marked where the plan says it runs. */
    await expect(
      wbsPanel(page).getByText('On the critical path', { exact: true }).first(),
    ).toBeVisible();

    /* 10. It validates and can be approved. */
    await settleOpenDocument(page);
    await expect(page.getByTestId('detail-status')).toHaveText('Approved');
  });

  /* 11, 12. */
  test('shows working days and never a date the estimate did not agree', async ({ page }) => {
    await throughStatementOfWork(page);
    await openDocument(page, 'WORK_BREAKDOWN_STRUCTURE');
    await page.getByTestId('generate-without-ai').click();
    await expect(wbsPanel(page)).toBeVisible({ timeout: 90_000 });

    /* 11. Relative days, because this project was planned in weeks with no start date. */
    await expect(wbsPanel(page).getByTestId('wbs-hours-1')).toContainText('days');

    /* 12. No calendar date anywhere: inventing the commencement is the failure here. */
    await expect(wbsPanel(page).getByText(/\d{4}-\d{2}-\d{2}/)).toHaveCount(0);
  });

  /* 13, 14, 15. */
  test('lets a task be reworded, and refuses a hand-edited schedule', async ({ page }) => {
    await throughStatementOfWork(page);
    await openDocument(page, 'WORK_BREAKDOWN_STRUCTURE');
    await page.getByTestId('generate-without-ai').click();
    await expect(wbsPanel(page)).toBeVisible({ timeout: 90_000 });

    /* The first task row, whichever outline number it has. */
    const rewordButton = wbsPanel(page)
      .getByRole('button', { name: 'Reword', exact: true })
      .first();

    /* 13. Rewording is offered on a task. */
    await expect(rewordButton).toBeVisible();
    await rewordButton.click();

    /* 14. The form says where the hours and the days are changed instead. */
    await expect(
      wbsPanel(page).getByText(/Hours, working days and the critical path come from the estimate/),
    ).toBeVisible();

    const taskInput = wbsPanel(page).getByRole('textbox').first();
    await taskInput.fill('Build the timesheet entry screen');
    await wbsPanel(page).getByRole('button', { name: 'Save', exact: true }).first().click();

    /* 15. The new wording is what the sheet shows. */
    await expect(wbsPanel(page).getByText('Build the timesheet entry screen')).toBeVisible({
      timeout: 60_000,
    });
  });

  /* 16, 17, 18. */
  test('writes the dependency sheet once the breakdown is approved', async ({ page }) => {
    await throughWbs(page);

    /* 16. Unlocked by the approved breakdown. */
    await expect(page.getByTestId('document-lock-CLIENT_DEPENDENCY_SHEET')).toBeHidden({
      timeout: 60_000,
    });

    await openDocument(page, 'CLIENT_DEPENDENCY_SHEET');
    await page.getByTestId('generate-without-ai').click();
    await expect(dependencyPanel(page)).toBeVisible({ timeout: 90_000 });

    /* 17. Rows, with a summary of what is outstanding. */
    await expect(dependencyPanel(page).getByTestId('dependency-rows')).toBeVisible();
    await expect(dependencyPanel(page).getByTestId('dependency-summary')).toContainText(
      'outstanding',
    );

    /* 18. Each row says where it came from, so a client can see why they are asked. */
    await expect(dependencyPanel(page).getByTestId('dependency-source-CD-001')).toContainText(
      'From',
    );
  });

  /* 19, 20, 21, 22, 23. */
  test('keeps arriving and working apart, all the way through', async ({ page }) => {
    await throughWbs(page);
    await openDocument(page, 'CLIENT_DEPENDENCY_SHEET');
    await page.getByTestId('generate-without-ai').click();
    await expect(dependencyPanel(page)).toBeVisible({ timeout: 90_000 });

    const panel = dependencyPanel(page);

    /* 19. Everything starts unrequested. */
    await expect(panel.getByTestId('dependency-status-CD-001')).toHaveText('Not requested yet');

    /* 20. Asked for. */
    await panel.getByTestId('dependency-request-CD-001').click();
    await expect(panel.getByTestId('dependency-status-CD-001')).toHaveText('Requested', {
      timeout: 60_000,
    });

    /*
     * 21. Arrived — and the status says so in those words. "Received, not checked" is
     * the whole point of the distinction, and it has to be legible without opening
     * anything.
     */
    await panel.getByTestId('dependency-receive-CD-001').click();
    await expect(panel.getByTestId('dependency-status-CD-001')).toHaveText(
      'Received, not checked',
      { timeout: 60_000 },
    );

    /* 22. What is offered next is a check, never an acceptance. */
    await expect(panel.getByTestId('dependency-check-CD-001')).toBeVisible();
    await panel.getByTestId('dependency-check-CD-001').click();

    /* Accepting is refused until somebody says what the check showed. */
    await expect(panel.getByTestId('dependency-accept-CD-001')).toBeDisabled();

    await panel
      .getByTestId('dependency-check-note-CD-001')
      .fill('Signed in with the sandbox account and called the test endpoint.');
    await expect(panel.getByTestId('dependency-accept-CD-001')).toBeEnabled();
    await panel.getByTestId('dependency-accept-CD-001').click();

    /* 23. Only now does it read as working, with the note kept beside it. */
    await expect(panel.getByTestId('dependency-status-CD-001')).toHaveText('Received and working', {
      timeout: 60_000,
    });
    await expect(panel.getByTestId('dependency-note-CD-001')).toContainText('sandbox account');
  });

  /* 24, 25. */
  test('records who owns an item without ever guessing', async ({ page }) => {
    await throughWbs(page);
    await openDocument(page, 'CLIENT_DEPENDENCY_SHEET');
    await page.getByTestId('generate-without-ai').click();
    await expect(dependencyPanel(page)).toBeVisible({ timeout: 90_000 });

    const panel = dependencyPanel(page);

    /* 24. Nobody is named until a person names them. */
    await expect(panel.getByTestId('dependency-owner-CD-001')).toBeHidden();

    await panel.getByTestId('dependency-set-owner-CD-001').click();
    await panel.getByTestId('dependency-client-owner-CD-001').fill('Operations lead');
    await panel.getByTestId('dependency-internal-owner-CD-001').fill('Delivery lead');
    await panel.getByTestId('dependency-owner-save-CD-001').click();

    /* 25. And then it is on the row. */
    await expect(panel.getByTestId('dependency-owner-CD-001')).toContainText('Operations lead', {
      timeout: 60_000,
    });
  });

  /* 26, 27, 28. */
  test('approves and issues the sheet with items still outstanding', async ({ page }) => {
    await throughWbs(page);
    await openDocument(page, 'CLIENT_DEPENDENCY_SHEET');
    await page.getByTestId('generate-without-ai').click();
    await expect(dependencyPanel(page)).toBeVisible({ timeout: 90_000 });

    /* 26. Outstanding items are reported rather than standing in the way. */
    await expect(dependencyPanel(page).getByTestId('dependency-summary')).toContainText(
      'outstanding',
    );

    await settleOpenDocument(page);

    /* 27. Approved with things still to arrive, because asking is what it is for. */
    await expect(page.getByTestId('detail-status')).toHaveText('Approved');
    await expect(validationPanel(page)).toBeVisible();

    /* 28. Issued, and still readable afterwards. */
    await page.getByTestId('mark-final').click();
    await expect(page.getByTestId('detail-status')).toHaveText('Issued', { timeout: 60_000 });
    await expect(dependencyPanel(page).getByTestId('dependency-rows')).toBeVisible();
  });

  /* ------------------------------------------------- responsive and axe */

  test.describe('both documents stay usable', () => {
    for (const [name, viewport] of [
      ['a phone', { width: 390, height: 844 }],
      ['a tablet', { width: 768, height: 1024 }],
      ['a desktop', { width: 1440, height: 900 }],
    ] as const) {
      test(`on ${name}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await throughStatementOfWork(page);

        await openDocument(page, 'WORK_BREAKDOWN_STRUCTURE');
        await page.getByTestId('generate-without-ai').click();
        await expect(wbsPanel(page)).toBeVisible({ timeout: 90_000 });
        await expect(wbsPanel(page).getByTestId('wbs-reconciliation')).toBeVisible();

        /*
         * An indented outline is the obvious thing to break on a narrow screen, so the
         * check is that the page itself never scrolls sideways at any width.
         */
        const wbsOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(wbsOverflow).toBeLessThanOrEqual(1);

        await expectNoAccessibilityViolations(page);

        /* And the sheet, which is the one a client is most likely to read on a phone. */
        await settleOpenDocument(page);
        await openDocument(page, 'CLIENT_DEPENDENCY_SHEET');
        await page.getByTestId('generate-without-ai').click();
        await expect(dependencyPanel(page)).toBeVisible({ timeout: 90_000 });

        const sheetOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(sheetOverflow).toBeLessThanOrEqual(1);

        await expectNoAccessibilityViolations(page);
      });
    }
  });
});
