import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ProjectCreatedResponse, ProjectResponse } from '@wdrg/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api-client';
import { WorkspaceShell } from './workspace-shell';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  fetchCurrentProject: vi.fn(),
}));

vi.mock('@/lib/project-api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...mocks };
});

const project: ProjectResponse = {
  projectId: 'prj_0123456789ABCDEFGHJKMNPQRS',
  status: 'DRAFT',
  version: 0,
  name: 'Northwind quoting platform',
  createdAt: '2026-08-06T09:00:00.000Z',
  updatedAt: '2026-08-06T09:00:00.000Z',
  expiresAt: '2026-09-05T09:00:00.000Z',
  lastAccessedAt: '2026-08-06T09:00:00.000Z',
};

const created: ProjectCreatedResponse = {
  project,
  recoverySecret: 'a'.repeat(43),
  recoveryLink: `http://localhost:3000/recover#p=${project.projectId}&s=${'a'.repeat(43)}`,
  recoveryWarning: 'Anyone with this link can open, edit and delete this project.',
};

function renderShell() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <WorkspaceShell />
    </QueryClientProvider>,
  );
}

describe('WorkspaceShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A 401 rather than a generic failure: the hook deliberately does not retry
    // "there is no session", which is an answer rather than an outage.
    mocks.fetchCurrentProject.mockRejectedValue(
      new ApiClientError('UNAUTHORIZED', 'No project session.', 401),
    );
    mocks.createProject.mockResolvedValue(created);
  });

  /**
   * A regression guard for a defect that component tests could not see.
   *
   * The creation panel used to seed the query cache itself. That told the shell
   * it had a project, which unmounted the panel — and with it the recovery link,
   * which is shown once and cannot be recovered from the server. Every part in
   * isolation behaved correctly; only the two together lost the secret.
   */
  it('keeps the recovery link on screen after creating a project', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.type(
      await screen.findByRole('textbox', { name: /project name/i }),
      'Northwind quoting platform',
    );
    await user.click(screen.getByRole('button', { name: /create project/i }));

    expect(await screen.findByDisplayValue(created.recoveryLink)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /save your private recovery link/i })).toBeVisible();

    // The workspace must not have taken over behind it.
    expect(screen.queryByRole('region', { name: /delivery timeline/i })).not.toBeInTheDocument();
  });

  it('enters the workspace only once the link is acknowledged', async () => {
    const user = userEvent.setup();
    renderShell();

    await user.type(
      await screen.findByRole('textbox', { name: /project name/i }),
      'Northwind quoting platform',
    );
    await user.click(screen.getByRole('button', { name: /create project/i }));

    await screen.findByDisplayValue(created.recoveryLink);
    await user.click(screen.getByLabelText(/i have saved this recovery link somewhere safe/i));
    await user.click(screen.getByRole('button', { name: /continue to the workspace/i }));

    expect(await screen.findByRole('region', { name: /delivery timeline/i })).toBeVisible();
    expect(
      screen.queryByRole('region', { name: /save your private recovery link/i }),
    ).not.toBeInTheDocument();
  });
});
