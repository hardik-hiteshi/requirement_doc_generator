import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { WCAG_22_AA_TAGS } from '@wdrg/testing';

/**
 * Browser-level accessibility checks.
 *
 * The component tests already run axe against rendered subtrees in jsdom. This
 * runs the same rule set against the real page in a real engine, which is where
 * the things jsdom cannot model live: computed contrast, actual focus order,
 * scroll containers, and a native `<dialog>` that is genuinely modal.
 *
 * The same WCAG 2.2 AA tag set is used in both places, imported rather than
 * restated, so the two layers cannot drift apart.
 */
export async function expectNoAccessibilityViolations(
  page: Page,
  options: { readonly within?: string } = {},
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([...WCAG_22_AA_TAGS]);

  if (options.within) {
    builder = builder.include(options.within);
  }

  const results = await builder.analyze();

  const report = results.violations
    .map((violation) => {
      const targets = violation.nodes
        .map((node) => {
          // The summary carries the numbers — measured contrast against
          // required contrast, for instance — without which a report says only
          // that something is wrong, not what to change it to.
          const why = (node.failureSummary ?? '').replace(/\n/g, '\n        ');
          return `      at ${node.target.join(' ')}\n        ${why}`;
        })
        .join('\n');

      return `  [${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help}\n${targets}`;
    })
    .join('\n');

  expect(report, `axe found ${results.violations.length} violation(s)`).toBe('');
}
