import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DocumentSnapshot, ProjectResponse } from '@wdrg/contracts';
import { assertNoAccessibilityViolations } from '@wdrg/testing';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BrandingSection } from '../project/branding-section';
import { ExportPanel } from './export-panel';

/**
 * The download and branding controls, without a browser or a server.
 *
 * The browser suite proves a real file arrives; these prove the things that are awkward
 * to provoke through a real workflow — that a failed download says so and changes nothing,
 * that a second click cannot start a second render, that an unsupported format is absent
 * rather than disabled, and that an archived version can be chosen without restoring it.
 */

const mocks = vi.hoisted(() => ({
  downloadDocumentExport: vi.fn(),
  readDocumentVersions: vi.fn(),
  updateBranding: vi.fn(),
  uploadBrandingLogo: vi.fn(),
}));

vi.mock('@/lib/documents-api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, downloadDocumentExport: mocks.downloadDocumentExport };
});

vi.mock('@/lib/project-api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    updateBranding: mocks.updateBranding,
    uploadBrandingLogo: mocks.uploadBrandingLogo,
  };
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

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    documentId: 'doc_understanding',
    type: 'OUR_UNDERSTANDING',
    projectId: project.projectId,
    version: 5,
    status: 'APPROVED',
    currentness: 'CURRENT',
    title: 'Our Understanding',
    prerequisiteVersions: {},
    sections: [],
    features: [],
    rows: [],
    blockers: [],
    outdatedReasons: [],
    schemaVersion: 1,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    recordVersion: 9,
    ...overrides,
  } as DocumentSnapshot;
}

function renderPanel(ui: ReactElement, versions: unknown[] = []) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  queryClient.setQueryData(['project', 'current'], project);
  queryClient.setQueryData(['documents', 'OUR_UNDERSTANDING', 'versions'], { versions });

  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }

  mocks.downloadDocumentExport.mockResolvedValue(undefined);
  mocks.updateBranding.mockResolvedValue({ ...project, version: project.version + 1 });
});

describe('the download panel', () => {
  it('offers only the formats the document supports', () => {
    renderPanel(<ExportPanel type="OUR_UNDERSTANDING" document={snapshot()} />);

    expect(screen.getByTestId('export-DOCX')).toBeInTheDocument();
    expect(screen.getByTestId('export-PDF')).toBeInTheDocument();

    /* Absent, not disabled: a control that cannot be used invites "why not?". */
    expect(screen.queryByTestId('export-CSV')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-XLSX')).not.toBeInTheDocument();
  });

  it('asks for the working version without a version number', async () => {
    renderPanel(<ExportPanel type="OUR_UNDERSTANDING" document={snapshot()} />);

    await userEvent.click(screen.getByTestId('export-DOCX'));

    expect(mocks.downloadDocumentExport).toHaveBeenCalledWith(
      'OUR_UNDERSTANDING',
      'DOCX',
      undefined,
    );
  });

  it('downloads an archived version without restoring it', async () => {
    renderPanel(<ExportPanel type="OUR_UNDERSTANDING" document={snapshot()} />, [
      { version: 5, status: 'APPROVED', currentness: 'CURRENT' },
      { version: 3, status: 'FINAL', currentness: 'OUTDATED' },
      { version: 1, status: 'DRAFT', currentness: 'OUTDATED' },
    ]);

    await userEvent.selectOptions(screen.getByTestId('export-version-select'), '3');

    /* The badges describe the version chosen, not the one that happens to be current. */
    expect(screen.getByTestId('export-version')).toHaveTextContent('v3');
    expect(screen.getByTestId('export-status')).toHaveTextContent('Issued');
    expect(screen.getByTestId('export-outdated-note')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('export-PDF'));

    expect(mocks.downloadDocumentExport).toHaveBeenCalledWith('OUR_UNDERSTANDING', 'PDF', 3);
  });

  it('hides the version control when there is only one version', () => {
    renderPanel(<ExportPanel type="OUR_UNDERSTANDING" document={snapshot({ version: 1 })} />);

    expect(screen.queryByTestId('export-version-select')).not.toBeInTheDocument();
  });

  it('believes the document over the history list about the version on screen', () => {
    /*
     * The history is a separate read and can lag. If it still describes the working version
     * as current after the document has gone stale, the panel must say what the document
     * says — the warning exists to stop somebody sending a stale file to a client.
     */
    renderPanel(
      <ExportPanel type="OUR_UNDERSTANDING" document={snapshot({ currentness: 'OUTDATED' })} />,
      [
        { version: 5, status: 'APPROVED', currentness: 'CURRENT' },
        { version: 2, status: 'DRAFT', currentness: 'OUTDATED' },
      ],
    );

    expect(screen.getByTestId('export-outdated-note')).toBeInTheDocument();
  });

  it('offers each version once, even when the history includes the working one', () => {
    renderPanel(<ExportPanel type="OUR_UNDERSTANDING" document={snapshot()} />, [
      { version: 5, status: 'APPROVED', currentness: 'CURRENT' },
      { version: 2, status: 'DRAFT', currentness: 'OUTDATED' },
    ]);

    const options = screen.getByTestId('export-version-select').querySelectorAll('option');

    expect([...options].map((option) => option.value)).toEqual(['5', '2']);
  });

  it('says a download failed, and leaves everything else alone', async () => {
    mocks.downloadDocumentExport.mockRejectedValue(new Error('The file could not be produced.'));

    renderPanel(<ExportPanel type="OUR_UNDERSTANDING" document={snapshot()} />);

    await userEvent.click(screen.getByTestId('export-PDF'));

    const error = await screen.findByTestId('export-error');

    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('The file could not be produced.');

    /* The document's own state is untouched, and the buttons are usable again. */
    expect(screen.getByTestId('export-status')).toHaveTextContent('Approved');
    expect(screen.getByTestId('export-PDF')).toBeEnabled();
  });

  it('passes on what the server said, so a ceiling explains itself', async () => {
    /*
     * The API answers with the standard envelope. Reading a bare `message` found
     * nothing and flattened every refusal into "could not be produced" — including a
     * rate ceiling, which is the one that tells the reader exactly what to do.
     */
    mocks.downloadDocumentExport.mockRejectedValue(
      new Error('That was too many requests in a short time. Nothing has been changed.'),
    );

    renderPanel(<ExportPanel type="OUR_UNDERSTANDING" document={snapshot()} />);

    await userEvent.click(screen.getByTestId('export-PDF'));

    expect(await screen.findByTestId('export-error')).toHaveTextContent('too many requests');
  });

  it('retries after a failure and clears the message', async () => {
    mocks.downloadDocumentExport.mockRejectedValueOnce(new Error('Try again.'));

    renderPanel(<ExportPanel type="OUR_UNDERSTANDING" document={snapshot()} />);

    await userEvent.click(screen.getByTestId('export-PDF'));
    await screen.findByTestId('export-error');

    await userEvent.click(screen.getByTestId('export-PDF'));

    await waitFor(() => {
      expect(screen.queryByTestId('export-error')).not.toBeInTheDocument();
    });

    expect(mocks.downloadDocumentExport).toHaveBeenCalledTimes(2);
  });

  it('cannot start a second render while one is in flight', async () => {
    let release: (() => void) | undefined;

    mocks.downloadDocumentExport.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    renderPanel(<ExportPanel type="OUR_UNDERSTANDING" document={snapshot()} />);

    await userEvent.click(screen.getByTestId('export-DOCX'));

    await waitFor(() => {
      expect(screen.getByTestId('export-DOCX')).toBeDisabled();
    });

    expect(screen.getByTestId('export-PDF')).toBeDisabled();
    expect(screen.getByTestId('export-DOCX')).toHaveTextContent('Preparing DOCX…');

    release?.();

    await waitFor(() => {
      expect(screen.getByTestId('export-DOCX')).toBeEnabled();
    });

    expect(mocks.downloadDocumentExport).toHaveBeenCalledTimes(1);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderPanel(
      <ExportPanel type="FEATURE_LISTING" document={snapshot({ type: 'FEATURE_LISTING' })} />,
      [
        { version: 5, status: 'APPROVED', currentness: 'CURRENT' },
        { version: 2, status: 'DRAFT', currentness: 'OUTDATED' },
      ],
    );

    await assertNoAccessibilityViolations(container);
  });
});

describe('the branding section', () => {
  it('refuses an accent colour that is not one, and will not save', async () => {
    renderPanel(<BrandingSection project={project} />);

    await userEvent.clear(screen.getByTestId('branding-accent'));
    await userEvent.type(screen.getByTestId('branding-accent'), 'rgb(0,0,0)');

    expect(screen.getByTestId('branding-accent-error')).toBeInTheDocument();
    expect(screen.getByTestId('branding-save')).toBeDisabled();
    expect(mocks.updateBranding).not.toHaveBeenCalled();
  });

  it('sends only what was filled in', async () => {
    renderPanel(<BrandingSection project={project} />);

    await userEvent.type(screen.getByTestId('branding-organization'), 'Hiteshi');
    await userEvent.click(screen.getByTestId('branding-save'));

    await waitFor(() => {
      expect(mocks.updateBranding).toHaveBeenCalledWith({
        branding: { organizationName: 'Hiteshi' },
        version: project.version,
      });
    });
  });

  it('treats an emptied field as unconfigured rather than blank', async () => {
    renderPanel(
      <BrandingSection
        project={{
          ...project,
          branding: { organizationName: 'Hiteshi', footerText: 'Confidential' },
        }}
      />,
    );

    await userEvent.clear(screen.getByTestId('branding-footer'));
    await userEvent.click(screen.getByTestId('branding-save'));

    await waitFor(() => {
      expect(mocks.updateBranding).toHaveBeenCalledWith({
        branding: { organizationName: 'Hiteshi' },
        version: project.version,
      });
    });
  });

  it('resets to the unbranded default', async () => {
    renderPanel(
      <BrandingSection project={{ ...project, branding: { organizationName: 'Hiteshi' } }} />,
    );

    await userEvent.click(screen.getByTestId('branding-reset'));

    expect(screen.getByTestId('branding-organization')).toHaveValue('');
  });

  it('reports a logo that could not be used without losing the form', async () => {
    mocks.uploadBrandingLogo.mockRejectedValue(new Error('A logo must be a PNG or a JPEG.'));

    renderPanel(<BrandingSection project={project} />);

    await userEvent.type(screen.getByTestId('branding-organization'), 'Hiteshi');

    await userEvent.upload(
      screen.getByTestId('branding-logo-input'),
      new File(['not an image'], 'logo.png', { type: 'image/png' }),
    );

    expect(await screen.findByText(/must be a PNG or a JPEG/)).toBeInTheDocument();

    /* What was already typed is still there: a logo problem is not a form problem. */
    expect(screen.getByTestId('branding-organization')).toHaveValue('Hiteshi');
  });

  it('has no accessibility violations', async () => {
    const { container } = renderPanel(<BrandingSection project={project} />);

    await assertNoAccessibilityViolations(within(container).getByRole('region').parentElement!);
  });
});
