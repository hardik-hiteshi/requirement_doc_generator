import { expect, test, type Download, type Page } from '@playwright/test';
import { inflateRawSync } from 'node:zlib';

import { expectNoAccessibilityViolations } from './support/accessibility';
import { API_URL } from './support/environment';
import { createProject, enterWorkspace, saveSection, section } from './support/workspace';

/**
 * Downloading documents, and the branding that decides how they look.
 *
 * The files are opened, not merely counted. A download event with the right extension
 * proves nothing about the bytes, and "the button worked" is exactly the assertion that
 * lets a renamed text file pass for a `.docx` — so a DOCX and an XLSX are checked for the
 * OOXML signature, a PDF for `%PDF-`, and a CSV is read back as text.
 *
 * The other thing under test is that downloading changes nothing. Several of these read the
 * version and status off the screen before and after a download and compare them, because
 * the whole phase rests on an export being a read.
 */

const documentsPanel = (page: Page) => page.getByRole('region', { name: 'Documents', exact: true });
const exportPanel = (page: Page) => page.getByRole('region', { name: 'Download' });
const brandingPanel = (page: Page) => page.getByRole('region', { name: 'Document branding' });

const BRIEF = [
  'Staff must sign in and record their weekly timesheets on a weekly grid screen.',
  'A manager must approve every timesheet before it is exported.',
  'The system must keep a history of every approval.',
].join('\n');

/** A 1×1 PNG, assembled here rather than committed as a binary fixture. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/* --------------------------------------------------------------- the chain */

/**
 * A new project, sitting on its first step.
 *
 * Split out from `reachDocuments` because branding is configured here and the workflow
 * offers no way back: once the documents step is open, the nav has no clickable step
 * buttons — only "Back to requirement input" — so anything on the project step has to be
 * done on the way through. That is also the order somebody would work in.
 */
async function startProject(page: Page): Promise<void> {
  await page.goto('/');
  await createProject(page, { name: 'Export and branding' });
  await enterWorkspace(page);
}

/** Everything upstream of the documents step, for a project that already exists. */
async function walkToDocuments(page: Page): Promise<void> {
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

/** A project sitting on the documents step with everything upstream approved. */
async function reachDocuments(page: Page): Promise<void> {
  await startProject(page);
  await walkToDocuments(page);
}

/** Open a document, waiting for the pane to show this one. Idempotent. */
async function openDocument(page: Page, type: string, title: string): Promise<void> {
  if (await page.getByTestId('detail-title').filter({ hasText: title }).count()) {
    return;
  }

  await expect(page.getByTestId(`document-open-${type}`)).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId(`document-open-${type}`).click();
  await expect(page.getByTestId('detail-title')).toHaveText(title, { timeout: 30_000 });
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

async function settle(page: Page, type: string, title: string): Promise<void> {
  await openDocument(page, type, title);
  await page.getByTestId('generate-without-ai').click();

  /*
   * Wait for the document to exist rather than for a version number: an ungenerated
   * document reports the version it would be written as, so waiting for "v1" passes before
   * anything has happened.
   */
  await expect(page.getByTestId('detail-status')).not.toHaveText('Not started', {
    timeout: 90_000,
  });
  await settleOpenDocument(page);
}

/* ----------------------------------------------------------- file checking */

async function bytesOf(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk as Buffer));
  }

  return Buffer.concat(chunks);
}

const isZip = (body: Buffer): boolean => body.subarray(0, 2).toString('latin1') === 'PK';
const isPdf = (body: Buffer): boolean => body.subarray(0, 5).toString('latin1') === '%PDF-';

/** The inflated text of a DOCX. The document part is deflated inside the package. */
function docxText(body: Buffer): string {
  const central = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

  let index = body.indexOf(central);

  while (index !== -1) {
    const nameLength = body.readUInt16LE(index + 28);

    if (
      body.subarray(index + 46, index + 46 + nameLength).toString('utf8') === 'word/document.xml'
    ) {
      const method = body.readUInt16LE(index + 10);
      const compressedSize = body.readUInt32LE(index + 20);
      const localOffset = body.readUInt32LE(index + 42);
      const start =
        localOffset +
        30 +
        body.readUInt16LE(localOffset + 26) +
        body.readUInt16LE(localOffset + 28);
      const data = body.subarray(start, start + compressedSize);

      return (method === 0 ? data : inflateRawSync(data)).toString('utf8');
    }

    index = body.indexOf(central, index + 4);
  }

  throw new Error('No word/document.xml in this package.');
}

/** Press a format button and return the file it produced. */
async function downloadFormat(page: Page, format: string): Promise<{ name: string; body: Buffer }> {
  const pending = page.waitForEvent('download', { timeout: 90_000 });

  await exportPanel(page).getByTestId(`export-${format}`).click();

  const download = await pending;

  return { name: download.suggestedFilename(), body: await bytesOf(download) };
}

/*
 * The whole chain plus several documents and a set of downloads, so the default per-test
 * budget is nowhere near enough.
 */
test.describe.configure({ timeout: 420_000 });

test.describe('Export and branding', () => {
  /* 1, 5, 6, 25. */
  test('exports the open document unbranded, and changes nothing by doing so', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');

    /* 1. Nothing configured is a supported way to run. */
    await expect(exportPanel(page)).toBeVisible();

    const versionBefore = await page.getByTestId('document-version').textContent();
    const statusBefore = await page.getByTestId('detail-status').textContent();

    /* 5. DOCX. */
    const docx = await downloadFormat(page, 'DOCX');

    /*
     * The whole filename, not just its extension. Chromium supplies an extension from the
     * content type when it has no name to work with, so matching only the suffix passes
     * even when the server's filename never reached the browser.
     */
    expect(docx.name).toMatch(/^Export-and-branding_Our-Understanding_v\d+\.docx$/);
    expect(isZip(docx.body)).toBe(true);
    expect(docx.body.byteLength).toBeGreaterThan(0);
    expect(docxText(docx.body)).toContain('Our Understanding');

    /* 6. PDF. */
    const pdf = await downloadFormat(page, 'PDF');

    expect(pdf.name).toMatch(/^Export-and-branding_Our-Understanding_v\d+\.pdf$/);
    expect(isPdf(pdf.body)).toBe(true);

    /* 25. The document did not move. */
    await expect(page.getByTestId('document-version')).toHaveText(versionBefore ?? '');
    await expect(page.getByTestId('detail-status')).toHaveText(statusBefore ?? '');
  });

  /* 23. */
  test('offers only the formats the document supports', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');

    /* Prose has no spreadsheet, and the button is absent rather than disabled. */
    await expect(exportPanel(page).getByTestId('export-DOCX')).toBeVisible();
    await expect(exportPanel(page).getByTestId('export-PDF')).toBeVisible();
    await expect(exportPanel(page).getByTestId('export-CSV')).toHaveCount(0);
    await expect(exportPanel(page).getByTestId('export-XLSX')).toHaveCount(0);
  });

  /* 7, 8, 9. */
  test('exports the structured documents as real spreadsheets', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');
    await settle(page, 'FEATURE_LISTING', 'Feature Listing');

    /* 7. The strict CSV, with its eight headers intact. */
    const csv = await downloadFormat(page, 'CSV');

    expect(csv.name).toMatch(/^Export-and-branding_Feature-Listing_v\d+\.csv$/);

    const header = csv.body
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .split('\r\n')[0];

    expect(header).toBe(
      '"Module","Sub Module","Screen","Detailed Feature Description","Estimated Hours - Backend Dev","Estimated Hours - Frontend Dev","Estimated Hours - QA","Estimated Hours - Other Roles (mention role)"',
    );

    /* 8. And the workbook. */
    const xlsx = await downloadFormat(page, 'XLSX');

    expect(xlsx.name).toMatch(/^Export-and-branding_Feature-Listing_v\d+\.xlsx$/);
    expect(isZip(xlsx.body)).toBe(true);

    /* 9. Acceptance Criteria as a spreadsheet. */
    await settle(page, 'ACCEPTANCE_CRITERIA', 'Acceptance Criteria');

    const criteria = await downloadFormat(page, 'XLSX');

    expect(criteria.name).toMatch(/^Export-and-branding_Acceptance-Criteria_v\d+\.xlsx$/);
    expect(isZip(criteria.body)).toBe(true);
  });

  /* 2, 3, 4, 26. */
  test('branding reaches the file and leaves the document alone', async ({ page }) => {
    await startProject(page);

    /* 2. An organisation name and a footer. */
    await expect(brandingPanel(page)).toBeVisible();
    await brandingPanel(page).getByTestId('branding-organization').fill('Hiteshi');
    await brandingPanel(page).getByTestId('branding-footer').fill('Commercial in confidence');

    /* 4. An accent colour. */
    await brandingPanel(page).getByTestId('branding-accent').fill('#1F3A5F');
    await expect(brandingPanel(page).getByTestId('branding-accent-error')).toHaveCount(0);

    /* 3. A logo, uploaded and scanned like any other file. */
    await brandingPanel(page)
      .getByTestId('branding-logo-input')
      .setInputFiles({ name: 'mark.png', mimeType: 'image/png', buffer: PNG });

    await expect(brandingPanel(page).getByTestId('branding-logo-name')).toContainText('mark.png', {
      timeout: 30_000,
    });

    await brandingPanel(page).getByTestId('branding-save').click();

    /*
     * Wait for the save to land before touching another section. Both share the project's
     * record version, so continuing while this is in flight would send the next save with
     * a stale one and earn a conflict the product is right to report.
     */
    await expect(brandingPanel(page).getByText('Saved', { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    /* Now walk to the documents and export under that branding. */
    await walkToDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');

    const versionBefore = await page.getByTestId('document-version').textContent();
    const branded = await downloadFormat(page, 'DOCX');

    /* The branding is in the file. */
    expect(docxText(branded.body)).toContain('Hiteshi');

    /* 26. And the document has not moved: branding is presentation, not authority. */
    await expect(page.getByTestId('document-version')).toHaveText(versionBefore ?? '');
    await expect(page.getByTestId('detail-status')).toHaveText('Approved');
  });

  test('an unbranded export carries no organisation name', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');

    const plain = await downloadFormat(page, 'DOCX');

    /* The default is genuinely unbranded rather than branded with a placeholder. */
    expect(docxText(plain.body)).not.toContain('Hiteshi');
    expect(docxText(plain.body)).toContain('Our Understanding');
  });

  /* Branding validation, and that a bad value never reaches a document. */
  test('refuses an accent colour that is not a colour', async ({ page }) => {
    await startProject(page);

    await brandingPanel(page).getByTestId('branding-accent').fill('rgb(0,0,0)');

    await expect(brandingPanel(page).getByTestId('branding-accent-error')).toBeVisible();
    await expect(brandingPanel(page).getByTestId('branding-save')).toBeDisabled();
  });

  /* 15, 16, 17. */
  test('exports a historical version, and gets that version', async ({ page }) => {
    await reachDocuments(page);
    await openDocument(page, 'OUR_UNDERSTANDING', 'Our Understanding');
    await page.getByTestId('generate-without-ai').click();
    await expect(page.getByTestId('detail-status')).not.toHaveText('Not started', {
      timeout: 90_000,
    });

    const firstVersion = await page.getByTestId('document-version').textContent();
    const first = await downloadFormat(page, 'DOCX');

    /* Move the document on with an edit. */
    const editButton = page
      .getByRole('region', { name: 'Document content' })
      .locator('[data-testid^="section-edit-"]')
      .first();

    const key = (await editButton.getAttribute('data-testid'))!.replace('section-edit-', '');

    await editButton.click();
    await page
      .getByTestId(`section-input-${key}`)
      .fill('Wording that belongs to the later version.');
    await page.getByTestId(`section-save-${key}`).click();

    await expect(page.getByTestId('document-version')).not.toHaveText(firstVersion ?? '', {
      timeout: 60_000,
    });

    const second = await downloadFormat(page, 'DOCX');

    /* 17. Two versions, two different files: no export reached for the latest. */
    expect(second.body.equals(first.body)).toBe(false);
    expect(docxText(second.body)).toContain('later version');
    expect(docxText(first.body)).not.toContain('later version');

    /*
     * 15, 16. And the earlier version can be downloaded from here, now, without restoring
     * it — which is the point: restoring to obtain a download would overwrite the version
     * somebody is working on in order to read an older one.
     */
    const earlier = (firstVersion ?? 'v1').replace('v', '');

    await exportPanel(page).getByTestId('export-version-select').selectOption(earlier);
    await expect(exportPanel(page).getByTestId('export-version')).toHaveText(`v${earlier}`);

    const archived = await downloadFormat(page, 'DOCX');

    /* 17. The bytes are the earlier version's, and the document has not moved. */
    expect(docxText(archived.body)).not.toContain('later version');
    expect(archived.name).toContain(`_v${earlier}`);
    await expect(page.getByTestId('document-version')).not.toHaveText(firstVersion ?? '');
  });

  /* 21, 22. */
  test('says on the file when a version is a draft', async ({ page }) => {
    await reachDocuments(page);
    await openDocument(page, 'OUR_UNDERSTANDING', 'Our Understanding');
    await page.getByTestId('generate-without-ai').click();
    await expect(page.getByTestId('detail-status')).toHaveText('Draft', { timeout: 90_000 });

    await expect(exportPanel(page).getByTestId('export-status')).toHaveText('Draft');

    const docx = await downloadFormat(page, 'DOCX');

    /* 22. A draft must not look like a finished document. */
    expect(docxText(docx.body)).toContain('Draft');
  });

  /* 18, 19, 20. */
  test('an issued version still exports as itself after a revision', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');

    await page.getByTestId('mark-final').click();
    await expect(page.getByTestId('detail-status')).toHaveText('Issued', { timeout: 60_000 });

    /* 18. The issued file names its lifecycle. */
    const issued = await downloadFormat(page, 'PDF');

    expect(issued.name).toMatch(/^Export-and-branding_Our-Understanding_v\d+_Issued\.pdf$/);
    expect(isPdf(issued.body)).toBe(true);

    /* 19. Revise it. */
    await page.getByTestId('document-reason').fill('A second issue is needed.');
    await page.getByTestId('revise-document').click();
    await expect(page.getByTestId('detail-status')).not.toHaveText('Issued', { timeout: 60_000 });

    /* 20. The issued version is still in the history and still exports as itself. */
    const versionsPanel = page.getByRole('region', { name: 'Document versions' });

    await expect(versionsPanel.getByText('Issued').first()).toBeVisible({ timeout: 30_000 });

    const issuedVersion = /_v(\d+)_Issued/.exec(issued.name)![1]!;

    await exportPanel(page).getByTestId('export-version-select').selectOption(issuedVersion);
    await expect(exportPanel(page).getByTestId('export-status')).toHaveText('Issued');

    const again = await downloadFormat(page, 'PDF');

    /* The same issued version, named as itself: the revision did not replace it. */
    expect(again.name).toBe(issued.name);
    expect(isPdf(again.body)).toBe(true);
    expect(again.body.byteLength).toBeGreaterThan(0);
  });

  /* 21. */
  test('an approved document that has gone stale says so, and still exports', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');
    await settle(page, 'FEATURE_LISTING', 'Feature Listing');

    /* Reopen Our Understanding, which leaves the approved Feature Listing behind it. */
    await openDocument(page, 'OUR_UNDERSTANDING', 'Our Understanding');
    await page.getByTestId('document-reason').fill('The client changed the scope.');
    await page.getByTestId('reopen-document').click();
    await expect(page.getByTestId('detail-status')).toHaveText('Needs changes', {
      timeout: 60_000,
    });

    await openDocument(page, 'FEATURE_LISTING', 'Feature Listing');

    /* The panel says the file will carry the warning, before anybody downloads it. */
    await expect(exportPanel(page).getByTestId('export-outdated-note')).toBeVisible({
      timeout: 60_000,
    });

    const docx = await downloadFormat(page, 'DOCX');
    const text = docxText(docx.body);

    /* Exported, not refused — and it does not read as current. */
    expect(text).toContain('inputs that have since changed');
    expect(text).toContain('Approved');
  });

  /* 24. */
  test('a download that fails is explained, and can be retried', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');

    const versionBefore = await page.getByTestId('document-version').textContent();

    /* Fail the render once, at the transport, which is what a renderer fault looks like. */
    await page.route('**/documents/OUR_UNDERSTANDING/export**', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'The file could not be produced. Please try again.' }),
      });
    });

    await exportPanel(page).getByTestId('export-PDF').click();

    const error = exportPanel(page).getByTestId('export-error');

    await expect(error).toBeVisible({ timeout: 60_000 });
    await expect(error).toContainText('try again', { ignoreCase: true });

    /* The document did not fail: only the file did. */
    await expect(page.getByTestId('document-version')).toHaveText(versionBefore ?? '');
    await expect(page.getByTestId('detail-status')).toHaveText('Approved');

    /* And the retry works. */
    await page.unroute('**/documents/OUR_UNDERSTANDING/export**');

    const pdf = await downloadFormat(page, 'PDF');

    expect(isPdf(pdf.body)).toBe(true);
    await expect(exportPanel(page).getByTestId('export-error')).toHaveCount(0);
  });

  /* 10, 11, 12, 13, 14. */
  test('exports the planning and dependency documents in every offered format', async ({
    page,
  }) => {
    await reachDocuments(page);

    for (const [type, title] of [
      ['OUR_UNDERSTANDING', 'Our Understanding'],
      ['FEATURE_LISTING', 'Feature Listing'],
      ['ACCEPTANCE_CRITERIA', 'Acceptance Criteria'],
      ['ASSUMPTIONS', 'Assumptions'],
      ['STATEMENT_OF_WORK', 'Statement of Work'],
      ['WORK_BREAKDOWN_STRUCTURE', 'Work Breakdown Structure'],
      ['CLIENT_DEPENDENCY_SHEET', 'Client Dependency Sheet'],
    ] as const) {
      await settle(page, type, title);
    }

    /* 10. The SOW as a PDF. */
    await openDocument(page, 'STATEMENT_OF_WORK', 'Statement of Work');

    const sow = await downloadFormat(page, 'PDF');

    expect(isPdf(sow.body)).toBe(true);
    expect(sow.name).toMatch(/_Statement-of-Work_v\d+\.pdf$/);

    /* 11, 12. The WBS as a workbook and as a document. */
    await openDocument(page, 'WORK_BREAKDOWN_STRUCTURE', 'Work Breakdown Structure');

    const wbsXlsx = await downloadFormat(page, 'XLSX');

    expect(isZip(wbsXlsx.body)).toBe(true);
    expect(wbsXlsx.name).toMatch(/_Work-Breakdown-Structure_v\d+\.xlsx$/);

    const wbsPdf = await downloadFormat(page, 'PDF');

    expect(isPdf(wbsPdf.body)).toBe(true);

    /* 13, 14. And the dependency sheet, which is the one that must never leak. */
    await openDocument(page, 'CLIENT_DEPENDENCY_SHEET', 'Client Dependency Sheet');

    const cdsXlsx = await downloadFormat(page, 'XLSX');

    expect(isZip(cdsXlsx.body)).toBe(true);

    const cdsPdf = await downloadFormat(page, 'PDF');

    expect(isPdf(cdsPdf.body)).toBe(true);
  });

  /* 23, 27. */
  test('refuses an unsupported format, and another project entirely', async ({ page, browser }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');

    const version = (await page.getByTestId('document-version').textContent())!.replace('v', '');

    /*
     * 23. The interface never offers a CSV for a prose document, so asking for one has to
     * be done directly — and the answer must be a refusal rather than a file.
     */
    const unsupported = await page.request.get(
      `${API_URL}/api/v1/projects/current/documents/OUR_UNDERSTANDING/export?format=CSV`,
    );

    expect(unsupported.status()).toBe(422);

    /* 27. A second session cannot reach this project's document, current or historical. */
    const other = await browser.newContext();
    const otherPage = await other.newPage();

    await otherPage.goto('/');
    await createProject(otherPage, { name: 'Stranger' });

    for (const query of [`format=PDF`, `format=PDF&version=${version}`]) {
      const response = await otherPage.request.get(
        `${API_URL}/api/v1/projects/current/documents/OUR_UNDERSTANDING/export?${query}`,
      );

      /* Never the owner's bytes, and refused the same way whatever was guessed. */
      expect([403, 404, 422]).toContain(response.status());

      const body = await response.body();

      expect(body.subarray(0, 5).toString('latin1')).not.toBe('%PDF-');
    }

    await other.close();
  });

  /* 28. */
  test('works with no AI provider at all', async ({ page }) => {
    await reachDocuments(page);
    await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');

    /* Everything above used the deterministic path; exporting must not need a model. */
    const pdf = await downloadFormat(page, 'PDF');

    expect(isPdf(pdf.body)).toBe(true);
  });

  /* ------------------------------------------------- responsive and axe */

  test.describe('the download and branding controls stay usable', () => {
    for (const [name, viewport] of [
      ['a phone', { width: 390, height: 844 }],
      ['a tablet', { width: 768, height: 1024 }],
      ['a desktop', { width: 1440, height: 900 }],
    ] as const) {
      test(`on ${name}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await startProject(page);

        /* Branding first, because the workflow does not come back to this step. */
        await expect(brandingPanel(page)).toBeVisible();
        await expectNoAccessibilityViolations(page);

        await walkToDocuments(page);
        await settle(page, 'OUR_UNDERSTANDING', 'Our Understanding');

        await expect(exportPanel(page)).toBeVisible();
        await expect(exportPanel(page).getByTestId('export-PDF')).toBeVisible();

        /* Basic actions must not push the page sideways. */
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );

        expect(overflow).toBeLessThanOrEqual(1);

        await expectNoAccessibilityViolations(page);
      });
    }
  });
});
