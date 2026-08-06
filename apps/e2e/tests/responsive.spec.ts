import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  createPanel,
  createProject,
  enterWorkspace,
  openDeleteDialog,
  projectPanel,
  recoveryPanel,
  saveSection,
  section,
  SECTIONS,
  type SectionKey,
} from './support/workspace';

/**
 * The workflow at the sizes people actually use.
 *
 * These are layout assertions, not screenshots. A visual snapshot would fail on
 * a font-rendering difference between a laptop and a CI runner while happily
 * passing a control that has slid off the side of the screen; measuring the
 * geometry catches the second and ignores the first.
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

/** Nothing may push the document wider than the window. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  // One pixel of slack for sub-pixel layout rounding; anything real is larger.
  expect(
    overflow.scrollWidth,
    `the page scrolls horizontally: ${overflow.scrollWidth}px of content in ${overflow.clientWidth}px`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/** The element is visible and lies inside the viewport horizontally. */
async function expectUsable(page: Page, target: Locator, description: string): Promise<void> {
  await expect(target, `${description} should be visible`).toBeVisible();

  const box = await target.boundingBox();
  expect(box, `${description} should have a layout box`).not.toBeNull();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  if (!box || !viewport) {
    return;
  }

  expect(box.x, `${description} starts off the left edge`).toBeGreaterThanOrEqual(-1);
  expect(
    box.x + box.width,
    `${description} extends past the right edge (${box.x + box.width}px > ${viewport.width}px)`,
  ).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.width, `${description} has no width`).toBeGreaterThan(0);
  expect(box.height, `${description} has no height`).toBeGreaterThan(0);
}

/**
 * Nothing else may sit on top of the element at its own centre point.
 *
 * Scrolled into view first, and measured with the element's own client
 * rectangle: `elementFromPoint` works in viewport coordinates, so asking it
 * about something below the fold answers a question about whatever happens to
 * be at that position on screen instead.
 */
async function expectNotCovered(target: Locator, description: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();

  const covered = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );

    return topmost === null || !(element.contains(topmost) || topmost.contains(element));
  });

  expect(covered, `${description} is hidden behind another element`).toBe(false);
}

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.name} (${viewport.width}x${viewport.height})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('the whole workflow stays usable', async ({ page }) => {
      /* Creation. */
      await page.goto('/');
      await expectNoHorizontalOverflow(page);

      const panel = createPanel(page);
      const nameField = panel.getByRole('textbox', { name: /Project name/ });

      await expectUsable(page, nameField, 'the project-name field');
      await expectUsable(
        page,
        panel.getByText('Project name', { exact: false }).first(),
        'its label',
      );
      await expectUsable(
        page,
        panel.getByRole('button', { name: 'Create project' }),
        'the create button',
      );
      await expectNotCovered(nameField, 'the project-name field');

      // A validation error must remain visible, not just present in the DOM.
      await panel.getByRole('button', { name: 'Create project' }).click();
      await expectUsable(page, panel.getByRole('alert').first(), 'the validation error');
      await expectNoHorizontalOverflow(page);

      const created = await createProject(page, {
        name: `Responsive ${viewport.name}`,
        clientName: 'Northwind Trading',
      });

      /* The recovery panel holds a long opaque string — the classic overflow. */
      const recovery = recoveryPanel(page);
      await expectUsable(page, recovery, 'the recovery-link panel');
      await expectUsable(
        page,
        recovery.getByRole('textbox', { name: 'Recovery link' }),
        'the recovery-link field',
      );
      await expectUsable(
        page,
        recovery.getByRole('button', { name: 'Copy link' }),
        'the copy button',
      );
      await expectNoHorizontalOverflow(page);

      expect(created.recoveryLink).toContain('#');

      await enterWorkspace(page);
      await expectNoHorizontalOverflow(page);

      /* Workflow navigation. */
      await expectUsable(
        page,
        page.getByRole('heading', { name: 'Workflow' }),
        'the workflow panel',
      );
      await expectUsable(page, page.getByRole('list').first(), 'the workflow steps');

      /* Every configuration section reachable, labelled and operable. */
      const saveLabels: Record<SectionKey, string> = {
        details: 'Save details',
        timeline: 'Save timeline',
        startDate: 'Save start date',
        teamCapacity: 'Save team and capacity',
        outputPreferences: 'Save export formats',
      };

      for (const key of Object.keys(SECTIONS) as SectionKey[]) {
        const target = section(page, key);

        await target.scrollIntoViewIfNeeded();
        await expectUsable(page, target, `the "${SECTIONS[key]}" section`);
        await expectUsable(
          page,
          target.getByRole('heading', { name: SECTIONS[key] }),
          `the "${SECTIONS[key]}" heading`,
        );

        const save = target.getByRole('button', { name: saveLabels[key] });
        await expectUsable(page, save, `the "${saveLabels[key]}" button`);
        await expectNotCovered(save, `the "${saveLabels[key]}" button`);
      }

      /* Output-format controls: the densest grid in the page. */
      const outputs = section(page, 'outputPreferences');
      const docx = outputs
        .getByRole('group', { name: /Our Understanding/ })
        .getByRole('checkbox', { name: 'DOCX', exact: true });

      await docx.scrollIntoViewIfNeeded();
      await expectUsable(page, docx, 'the DOCX format control');
      await docx.check();
      await expect(docx).toBeChecked();
      await saveSection(page, 'outputPreferences');
      await expectNoHorizontalOverflow(page);

      /* Focus indicators survive at every size. */
      const timelineSave = section(page, 'timeline').getByRole('button', { name: 'Save timeline' });
      await timelineSave.focus();
      await expect(timelineSave).toBeFocused();

      const focusRing = await timelineSave.evaluate((element) => {
        const style = window.getComputedStyle(element, ':focus-visible');
        return {
          outlineWidth: style.outlineWidth,
          outlineStyle: style.outlineStyle,
          boxShadow: style.boxShadow,
        };
      });

      const hasVisibleFocus =
        (focusRing.outlineStyle !== 'none' && focusRing.outlineWidth !== '0px') ||
        (focusRing.boxShadow !== 'none' && focusRing.boxShadow !== '');
      expect(hasVisibleFocus, `no focus indicator at ${viewport.name}`).toBe(true);

      /* Deletion confirmation, including the modal's own bounds. */
      await projectPanel(page).scrollIntoViewIfNeeded();
      const dialog = await openDeleteDialog(page);

      await expectUsable(page, dialog, 'the delete dialog');
      await expectNoHorizontalOverflow(page);

      const dialogBox = await dialog.boundingBox();
      const size = page.viewportSize();
      expect(dialogBox).not.toBeNull();
      expect(size).not.toBeNull();

      if (dialogBox && size) {
        expect(dialogBox.x, 'the dialog starts off-screen').toBeGreaterThanOrEqual(-1);
        expect(dialogBox.x + dialogBox.width, 'the dialog runs off-screen').toBeLessThanOrEqual(
          size.width + 1,
        );
        expect(dialogBox.height, 'the dialog is taller than the viewport').toBeLessThanOrEqual(
          size.height + 1,
        );
      }

      const confirmation = dialog.getByRole('textbox', {
        name: /Type the project name to confirm/,
      });
      await expectUsable(page, confirmation, 'the confirmation field');
      await expectUsable(
        page,
        dialog.getByRole('button', { name: 'Delete permanently' }),
        'the delete button',
      );
      await expectUsable(
        page,
        dialog.getByRole('button', { name: 'Keep project' }),
        'the keep button',
      );
      await expectNotCovered(confirmation, 'the confirmation field');

      await dialog.getByRole('button', { name: 'Keep project' }).click();
      await expect(dialog).toBeHidden();
    });
  });
}
