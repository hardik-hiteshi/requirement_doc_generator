import { expect, test } from '@playwright/test';

import { expectNoAccessibilityViolations } from './support/accessibility';
import {
  createPanel,
  createProject,
  enterWorkspace,
  openDeleteDialog,
  section,
} from './support/workspace';

/**
 * Accessibility in a real engine.
 *
 * The component suite runs the same WCAG 2.2 AA rule set in jsdom, which cannot
 * compute contrast, cannot lay anything out, and treats `<dialog>` as an
 * ordinary element. Everything below therefore checks something the component
 * tests structurally cannot.
 *
 * Both viewports are covered because several rules — target size, contrast
 * against a different background, reflow — only apply once the layout responds.
 */

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('project creation has no violations', async ({ page }) => {
      await page.goto('/');
      await expect(createPanel(page)).toBeVisible();

      await expectNoAccessibilityViolations(page);
    });

    test('the recovery flow has no violations', async ({ page, browser }) => {
      await page.goto('/');
      const created = await createProject(page, { name: `Recovery a11y ${viewport.name}` });

      // The recovery-link panel, where the warning and the acknowledgement live.
      await expectNoAccessibilityViolations(page);

      // And the recovery page itself, in a browser that has never seen this
      // project — including its failure state, which is the branch a user in
      // trouble actually reads.
      const returning = await browser.newContext();
      const returningPage = await returning.newPage();

      await returningPage.goto(`${new URL(created.recoveryLink).origin}/recover#p=nope&s=nope`);
      await expect(returningPage.getByRole('link', { name: 'Start a new project' })).toBeVisible();
      await expectNoAccessibilityViolations(returningPage);

      await returningPage.goto(created.recoveryLink);
      await expect(section(returningPage, 'details')).toBeVisible();

      await returning.close();
    });

    test('the main workspace has no violations', async ({ page }) => {
      await page.goto('/');
      await createProject(page, { name: `Workspace a11y ${viewport.name}` });
      await enterWorkspace(page);

      await expectNoAccessibilityViolations(page);
    });

    test('the delete confirmation dialog has no violations', async ({ page }) => {
      await page.goto('/');
      await createProject(page, { name: `Dialog a11y ${viewport.name}` });
      await enterWorkspace(page);

      const dialog = await openDeleteDialog(page);
      await expect(dialog).toBeVisible();

      // Scanned as a modal in its own right, so a violation inside it cannot be
      // diluted by the rest of the page passing.
      await expectNoAccessibilityViolations(page, { within: 'dialog[open]' });
      await expectNoAccessibilityViolations(page);
    });
  });
}
