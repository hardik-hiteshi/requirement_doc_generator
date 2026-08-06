import { expect, type Locator, type Page } from '@playwright/test';
import { parseRecoveryFragment } from '@wdrg/contracts';

/**
 * The workspace, expressed as the things a user can do to it.
 *
 * Every locator is a role and an accessible name — the same route a screen
 * reader takes. That is deliberate: a selector that only a test can follow will
 * keep passing after the UI becomes unusable, which is the opposite of what this
 * suite is for.
 */

export interface CreatedProject {
  readonly projectId: string;
  readonly recoverySecret: string;
  readonly recoveryLink: string;
}

/** The five configurable sections, keyed by the landmark that contains each. */
export const SECTIONS = {
  details: 'Project details',
  timeline: 'Delivery timeline',
  startDate: 'Project start date',
  teamCapacity: 'Team and capacity',
  outputPreferences: 'Export formats',
} as const;

export type SectionKey = keyof typeof SECTIONS;

export function section(page: Page, key: SectionKey): Locator {
  return page.getByRole('region', { name: SECTIONS[key], exact: true });
}

export function createPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Start a new project', exact: true });
}

export function recoveryPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Save your private recovery link', exact: true });
}

export function projectPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'This project', exact: true });
}

/**
 * Creates a project and stops on the recovery-link panel.
 *
 * Split from `enterWorkspace` because several scenarios need to inspect the
 * page, the URL and the network at exactly this point — after the secret exists
 * but before anything navigates.
 */
export async function createProject(
  page: Page,
  options: { readonly name: string; readonly clientName?: string },
): Promise<CreatedProject> {
  const panel = createPanel(page);
  await expect(panel).toBeVisible();

  await panel.getByRole('textbox', { name: /Project name/ }).fill(options.name);

  if (options.clientName) {
    await panel.getByRole('textbox', { name: /Client name/ }).fill(options.clientName);
  }

  await panel.getByRole('button', { name: 'Create project' }).click();

  const recovery = recoveryPanel(page);
  await expect(recovery).toBeVisible();

  const recoveryLink = await recovery.getByRole('textbox', { name: 'Recovery link' }).inputValue();
  const parsed = parseRecoveryFragment(recoveryLink.split('#')[1] ?? '');

  if (!parsed) {
    throw new Error(`The recovery link is not in the documented shape: ${recoveryLink}`);
  }

  return { ...parsed, recoveryLink };
}

/** Acknowledges the recovery warning and continues into the workspace. */
export async function enterWorkspace(page: Page): Promise<void> {
  const recovery = recoveryPanel(page);

  await recovery.getByRole('checkbox', { name: /I have saved this recovery link/ }).check();
  await recovery.getByRole('button', { name: 'Continue to the workspace' }).click();

  await expect(section(page, 'details')).toBeVisible();
}

/** Submits one section and waits for it to report a successful save. */
export async function saveSection(page: Page, key: SectionKey): Promise<void> {
  const target = section(page, key);
  const saveLabels: Record<SectionKey, string> = {
    details: 'Save details',
    timeline: 'Save timeline',
    startDate: 'Save start date',
    teamCapacity: 'Save team and capacity',
    outputPreferences: 'Save export formats',
  };

  await target.getByRole('button', { name: saveLabels[key] }).click();
  await expect(target.getByText('Saved', { exact: true })).toBeVisible();
}

/**
 * Fills all five sections with a known configuration and saves each.
 *
 * The values are fixed rather than generated so that "the recovered project
 * matches what was saved" is a comparison against a literal, not against
 * whatever the test happened to produce earlier.
 */
export const CONFIGURED = {
  clientName: 'Northwind Trading',
  description: 'Replaces the legacy quoting tool.',
  projectTypes: ['SaaS platform', 'Mobile application'],
  timelineWeeks: '18',
  startDateMode: 'Tentative start date',
  frontendDevelopers: '3',
  qaEngineers: '2',
  outputFormats: { document: 'Our Understanding', formats: ['DOCX', 'PDF'] },
} as const;

export async function configureEverySection(page: Page): Promise<void> {
  /* Details, including the project type later phases need. */
  const details = section(page, 'details');
  await details.getByRole('textbox', { name: /Client name/ }).fill(CONFIGURED.clientName);
  await details.getByRole('textbox', { name: /Description or notes/ }).fill(CONFIGURED.description);

  for (const label of CONFIGURED.projectTypes) {
    await details.getByRole('checkbox', { name: label, exact: true }).check();
  }

  await saveSection(page, 'details');

  /* Timeline — the one mandatory planning input. */
  const timeline = section(page, 'timeline');
  await timeline.getByRole('radio', { name: 'Weeks', exact: true }).check();
  await timeline.getByRole('spinbutton', { name: /Weeks/ }).fill(CONFIGURED.timelineWeeks);
  await saveSection(page, 'timeline');

  /* Start date. */
  const startDate = section(page, 'startDate');
  await startDate.getByRole('radio', { name: CONFIGURED.startDateMode }).check();
  await expect(startDate.getByRole('textbox', { name: /Start date/ })).toBeVisible();
  await saveSection(page, 'startDate');

  /* Team capacity. */
  const capacity = section(page, 'teamCapacity');
  await capacity
    .getByRole('spinbutton', { name: /Frontend developer/ })
    .fill(CONFIGURED.frontendDevelopers);
  await capacity.getByRole('spinbutton', { name: /QA engineer/ }).fill(CONFIGURED.qaEngineers);
  await saveSection(page, 'teamCapacity');

  /* Output preferences. */
  const outputs = section(page, 'outputPreferences');
  const document = outputs.getByRole('group', {
    name: new RegExp(CONFIGURED.outputFormats.document),
  });

  for (const format of CONFIGURED.outputFormats.formats) {
    await document.getByRole('checkbox', { name: format, exact: true }).check();
  }

  await saveSection(page, 'outputPreferences');
}

/** Asserts the saved configuration is what the workspace currently shows. */
export async function expectConfiguredStateVisible(page: Page): Promise<void> {
  const details = section(page, 'details');
  await expect(details.getByRole('textbox', { name: /Client name/ })).toHaveValue(
    CONFIGURED.clientName,
  );
  await expect(details.getByRole('textbox', { name: /Description or notes/ })).toHaveValue(
    CONFIGURED.description,
  );

  for (const label of CONFIGURED.projectTypes) {
    await expect(details.getByRole('checkbox', { name: label, exact: true })).toBeChecked();
  }

  const timeline = section(page, 'timeline');
  await expect(timeline.getByRole('radio', { name: 'Weeks', exact: true })).toBeChecked();
  await expect(timeline.getByRole('spinbutton', { name: /Weeks/ })).toHaveValue(
    CONFIGURED.timelineWeeks,
  );

  await expect(
    section(page, 'startDate').getByRole('radio', { name: CONFIGURED.startDateMode }),
  ).toBeChecked();

  const capacity = section(page, 'teamCapacity');
  await expect(capacity.getByRole('spinbutton', { name: /Frontend developer/ })).toHaveValue(
    CONFIGURED.frontendDevelopers,
  );
  await expect(capacity.getByRole('spinbutton', { name: /QA engineer/ })).toHaveValue(
    CONFIGURED.qaEngineers,
  );

  const outputs = section(page, 'outputPreferences');
  const document = outputs.getByRole('group', {
    name: new RegExp(CONFIGURED.outputFormats.document),
  });

  for (const format of CONFIGURED.outputFormats.formats) {
    await expect(document.getByRole('checkbox', { name: format, exact: true })).toBeChecked();
  }
}

/** Opens a recovery link in the given page and waits for the outcome. */
export async function redeemRecoveryLink(page: Page, recoveryLink: string): Promise<void> {
  await page.goto(recoveryLink);
}

/** Opens the delete dialog from the project side panel. */
export async function openDeleteDialog(page: Page): Promise<Locator> {
  await projectPanel(page).getByRole('button', { name: 'Delete project' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  return dialog;
}
