import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ALLOWED_FORMATS,
  PROJECT_NOT_MODIFIABLE_MESSAGE,
  type ProjectResponse,
} from '@wdrg/contracts';
import { assertNoAccessibilityViolations } from '@wdrg/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DetailsSection } from './details-section';
import { OutputPreferencesSection } from './output-preferences-section';
import { StartDateSection } from './start-date-section';
import { TeamCapacitySection } from './team-capacity-section';
import { TimelineSection } from './timeline-section';

const mocks = vi.hoisted(() => ({
  updateDetails: vi.fn(),
  updateTimeline: vi.fn(),
  updateStartDate: vi.fn(),
  updateTeamCapacity: vi.fn(),
  updateOutputPreferences: vi.fn(),
}));

vi.mock('@/lib/project-api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...mocks };
});

const project: ProjectResponse = {
  projectId: 'prj_0123456789ABCDEFGHJKMNPQRS',
  status: 'ACTIVE',
  version: 4,
  name: 'Acme portal',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-05T00:00:00.000Z',
  lastAccessedAt: '2026-08-05T00:00:00.000Z',
  expiresAt: '2026-09-01T00:00:00.000Z',
};

function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    // No gcTime override: the seeded project has no observer in these tests, so
    // a zero gcTime would evict it before the section hook reads the version.
    defaultOptions: { queries: { retry: false } },
  });
  // The section hooks read the version from the cache.
  queryClient.setQueryData(['project', 'current'], project);

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
    mock.mockResolvedValue({ ...project, version: project.version + 1 });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DetailsSection', () => {
  it('submits the edited details with the current version', async () => {
    const user = userEvent.setup();
    renderWithClient(<DetailsSection project={project} />);

    const name = screen.getByLabelText(/project name/i);
    await user.clear(name);
    await user.type(name, 'Renamed project');
    await user.click(screen.getByRole('button', { name: /save details/i }));

    await waitFor(() => expect(mocks.updateDetails).toHaveBeenCalledTimes(1));
    expect(mocks.updateDetails.mock.calls[0]?.[0]).toMatchObject({
      version: 4,
      details: { name: 'Renamed project' },
    });
  });

  it('shows a saved indicator once the save succeeds', async () => {
    const user = userEvent.setup();
    renderWithClient(<DetailsSection project={project} />);

    await user.click(screen.getByRole('button', { name: /save details/i }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('reports a version conflict distinctly from a generic error', async () => {
    const { ApiClientError } = await import('@/lib/api-client');
    mocks.updateDetails.mockRejectedValue(
      new ApiClientError('CONFLICT', 'Changed elsewhere since you loaded it.', 409, undefined, [
        { path: 'version', message: 'Expected version 1.', rule: 'version_conflict' },
      ]),
    );

    const user = userEvent.setup();
    renderWithClient(<DetailsSection project={project} />);
    await user.click(screen.getByRole('button', { name: /save details/i }));

    expect(await screen.findByText('Changed elsewhere')).toBeInTheDocument();
  });

  it('does not call an unmodifiable project a conflict', async () => {
    // Expiry and a version conflict share HTTP 409, but only one of them is
    // fixed by reloading — telling an expired project's owner that somebody
    // else edited it would send them chasing a change that never happened.
    const { ApiClientError } = await import('@/lib/api-client');
    mocks.updateDetails.mockRejectedValue(
      new ApiClientError('CONFLICT', PROJECT_NOT_MODIFIABLE_MESSAGE, 409),
    );

    const user = userEvent.setup();
    renderWithClient(<DetailsSection project={project} />);
    await user.click(screen.getByRole('button', { name: /save details/i }));

    expect(await screen.findByText('Not saved')).toBeInTheDocument();
    expect(screen.getByText(PROJECT_NOT_MODIFIABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText('Changed elsewhere')).not.toBeInTheDocument();
  });

  it('offers every project type', () => {
    renderWithClient(<DetailsSection project={project} />);

    const group = screen.getByRole('group', { name: /project type/i });
    expect(within(group).getByLabelText('SaaS platform')).toBeInTheDocument();
    expect(within(group).getByLabelText('Migration')).toBeInTheDocument();
    expect(within(group).getByLabelText('Multi-platform product')).toBeInTheDocument();
  });

  it('has no automatically detectable accessibility violations', async () => {
    const { container } = renderWithClient(<DetailsSection project={project} />);
    await assertNoAccessibilityViolations(container);
  });
});

describe('TimelineSection', () => {
  it('offers all four timeline modes', () => {
    renderWithClient(<TimelineSection project={project} />);

    for (const label of [/working days/i, /weeks/i, /months/i, /fixed client deadline/i]) {
      expect(screen.getByRole('radio', { name: label })).toBeInTheDocument();
    }
  });

  it('replaces the value when the mode changes, so two modes cannot be sent', async () => {
    const user = userEvent.setup();
    renderWithClient(<TimelineSection project={project} />);

    await user.click(screen.getByRole('radio', { name: /^months$/i }));
    await user.click(screen.getByRole('button', { name: /save timeline/i }));

    await waitFor(() => expect(mocks.updateTimeline).toHaveBeenCalled());
    const sent = mocks.updateTimeline.mock.calls[0]?.[0].timeline;

    expect(sent.mode).toBe('MONTHS');
    expect(sent).not.toHaveProperty('weeks');
    expect(sent).not.toHaveProperty('deadline');
  });

  it('shows a date input only for the fixed-deadline mode', async () => {
    const user = userEvent.setup();
    renderWithClient(<TimelineSection project={project} />);

    expect(screen.queryByLabelText(/client delivery deadline/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /fixed client deadline/i }));
    expect(screen.getByLabelText(/client delivery deadline/i)).toBeInTheDocument();
  });

  it('states that the timeline is authoritative', () => {
    renderWithClient(<TimelineSection project={project} />);
    expect(screen.getByText(/never silently extended/i)).toBeInTheDocument();
  });

  it('has no automatically detectable accessibility violations', async () => {
    const { container } = renderWithClient(<TimelineSection project={project} />);
    await assertNoAccessibilityViolations(container);
  });
});

describe('StartDateSection', () => {
  it('offers all four modes and defaults to not confirmed', () => {
    renderWithClient(<StartDateSection project={project} />);

    expect(screen.getByRole('radio', { name: /start date not confirmed/i })).toBeChecked();
    expect(screen.getByRole('radio', { name: /confirmed start date/i })).toBeInTheDocument();
  });

  it('asks for a date only for the dated modes', async () => {
    const user = userEvent.setup();
    renderWithClient(<StartDateSection project={project} />);

    expect(screen.queryByLabelText(/^start date\s*\*?$/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /tentative start date/i }));
    expect(screen.getByLabelText(/^start date\s*\*?$/i)).toBeInTheDocument();
  });

  it('explains that estimation does not need a start date', () => {
    renderWithClient(<StartDateSection project={project} />);
    expect(screen.getByText(/never need a start date/i)).toBeInTheDocument();
  });

  it('explains that calendar dates require one', () => {
    renderWithClient(<StartDateSection project={project} />);
    expect(
      screen.getByText(/calendar dates become available only once you provide a start date/i),
    ).toBeInTheDocument();
  });

  it('submits without a date when the mode carries none', async () => {
    const user = userEvent.setup();
    renderWithClient(<StartDateSection project={project} />);

    await user.click(screen.getByRole('button', { name: /save start date/i }));

    await waitFor(() => expect(mocks.updateStartDate).toHaveBeenCalled());
    expect(mocks.updateStartDate.mock.calls[0]?.[0].startDate).toEqual({ mode: 'NOT_CONFIRMED' });
  });

  it('has no automatically detectable accessibility violations', async () => {
    const { container } = renderWithClient(<StartDateSection project={project} />);
    await assertNoAccessibilityViolations(container);
  });
});

describe('TeamCapacitySection', () => {
  it('renders an input for every standard role', () => {
    renderWithClient(<TeamCapacitySection project={project} />);

    for (const label of [/frontend developer/i, /qa engineer/i, /ai\/ml engineer/i]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('adds and removes a custom role', async () => {
    const user = userEvent.setup();
    renderWithClient(<TeamCapacitySection project={project} />);

    await user.click(screen.getByRole('button', { name: /add a role/i }));
    expect(screen.getByLabelText(/role name/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /remove/i }));
    expect(screen.queryByLabelText(/role name/i)).not.toBeInTheDocument();
  });

  it('lets the user ask for a staffing recommendation instead', async () => {
    const user = userEvent.setup();
    renderWithClient(<TeamCapacitySection project={project} />);

    await user.click(screen.getByLabelText(/recommend the staffing needed/i));
    await user.click(screen.getByRole('button', { name: /save team and capacity/i }));

    await waitFor(() => expect(mocks.updateTeamCapacity).toHaveBeenCalled());
    expect(mocks.updateTeamCapacity.mock.calls[0]?.[0].teamCapacity).toMatchObject({
      requestStaffingRecommendation: true,
    });
  });

  it('says capacity is optional', () => {
    renderWithClient(<TeamCapacitySection project={project} />);
    expect(screen.getByText(/all optional/i)).toBeInTheDocument();
  });

  it('has no automatically detectable accessibility violations', async () => {
    const { container } = renderWithClient(<TeamCapacitySection project={project} />);
    await assertNoAccessibilityViolations(container);
  });
});

describe('OutputPreferencesSection', () => {
  it('offers only the formats each document supports', () => {
    renderWithClient(<OutputPreferencesSection project={project} />);

    const understanding = screen.getByRole('group', { name: /our understanding/i });
    const labels = within(understanding)
      .getAllByRole('checkbox')
      .map((input) => input.getAttribute('value') ?? input.parentElement?.textContent?.trim());

    // Prose documents are not offered as spreadsheets.
    expect(within(understanding).queryByLabelText('CSV')).not.toBeInTheDocument();
    expect(within(understanding).queryByLabelText('XLSX')).not.toBeInTheDocument();
    expect(labels).toHaveLength(ALLOWED_FORMATS.OUR_UNDERSTANDING.length);
  });

  it('offers spreadsheet formats for the tabular documents', () => {
    renderWithClient(<OutputPreferencesSection project={project} />);

    const wbs = screen.getByRole('group', { name: /work breakdown structure/i });
    expect(within(wbs).getByLabelText('XLSX')).toBeInTheDocument();
    expect(within(wbs).getByLabelText('CSV')).toBeInTheDocument();
  });

  it('lists all seven documents in generation order', () => {
    renderWithClient(<OutputPreferencesSection project={project} />);

    const groups = screen.getAllByRole('group');
    expect(groups).toHaveLength(7);
    expect(groups[0]).toHaveTextContent('1. Our Understanding');
    expect(groups[6]).toHaveTextContent('7. Client Dependency Sheet');
  });

  it('states that no files are generated yet', () => {
    renderWithClient(<OutputPreferencesSection project={project} />);
    expect(screen.getByText(/nothing is generated yet/i)).toBeInTheDocument();
  });

  it('has no automatically detectable accessibility violations', async () => {
    const { container } = renderWithClient(<OutputPreferencesSection project={project} />);
    await assertNoAccessibilityViolations(container);
  });
});
