import axe, { type AxeResults, type Result, type RunOptions } from 'axe-core';

/**
 * WCAG 2.2 AA is the project's accessibility target, so automated checks run the
 * corresponding axe rule tags. Automated tooling catches roughly a third of real
 * issues — it is a regression guard, not a substitute for the manual audit
 * scheduled in the hardening phase.
 */
export const WCAG_22_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

export interface AccessibilityScanOptions {
  /** Override the axe rule tags. Defaults to the WCAG 2.2 AA set. */
  readonly tags?: readonly string[];
  /** Rule ids to disable, with a comment explaining why, at the call site. */
  readonly disabledRules?: readonly string[];
}

/** Runs axe against a DOM subtree and returns the raw results. */
export async function scanForAccessibilityViolations(
  container: Element,
  options: AccessibilityScanOptions = {},
): Promise<AxeResults> {
  const runOptions: RunOptions = {
    runOnly: { type: 'tag', values: [...(options.tags ?? WCAG_22_AA_TAGS)] },
  };

  if (options.disabledRules && options.disabledRules.length > 0) {
    runOptions.rules = Object.fromEntries(
      options.disabledRules.map((rule) => [rule, { enabled: false }]),
    );
  }

  return axe.run(container, runOptions);
}

/** Renders axe violations as a readable assertion message. */
export function formatAccessibilityViolations(violations: readonly Result[]): string {
  return violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => `      at ${node.target.join(' ')}`).join('\n');

      return `  [${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help}\n${targets}`;
    })
    .join('\n');
}

/**
 * Throws with a readable report when the subtree has accessibility violations.
 *
 * Usable from any test runner because it throws a plain `Error` rather than
 * depending on a specific `expect` implementation.
 */
export async function assertNoAccessibilityViolations(
  container: Element,
  options: AccessibilityScanOptions = {},
): Promise<void> {
  const results = await scanForAccessibilityViolations(container, options);

  if (results.violations.length > 0) {
    throw new Error(
      `Found ${results.violations.length} accessibility violation(s):\n${formatAccessibilityViolations(
        results.violations,
      )}`,
    );
  }
}
