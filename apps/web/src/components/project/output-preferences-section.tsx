'use client';

import {
  ALLOWED_FORMATS,
  DEFAULT_OUTPUT_PREFERENCES,
  PROJECT_DOCUMENTS,
  PROJECT_DOCUMENT_LABELS,
  PROJECT_DOCUMENT_ORDER,
  type ExportFormat,
  type OutputPreferences,
  type ProjectDocument,
  type ProjectResponse,
} from '@wdrg/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useSectionSave } from '@/hooks/use-project';
import { updateOutputPreferences } from '@/lib/project-api';
import { SaveStatus } from './save-status';

/**
 * Export-format preferences per document.
 *
 * Only the formats a document actually supports are offered — an unavailable
 * format is not rendered as a disabled option, because a control that exists but
 * cannot be used invites the question "why not?" on every visit.
 */
export function OutputPreferencesSection({ project }: { project: ProjectResponse }) {
  const [preferences, setPreferences] = useState<OutputPreferences>(
    () => project.outputPreferences ?? DEFAULT_OUTPUT_PREFERENCES,
  );

  const { save, state, message } = useSectionSave<{ outputPreferences: OutputPreferences }>({
    mutate: updateOutputPreferences,
  });

  function toggle(document: ProjectDocument, format: ExportFormat) {
    const current = preferences[document] ?? [];
    const next = current.includes(format)
      ? current.filter((value) => value !== format)
      : [...current, format];

    const updated = { ...preferences };

    if (next.length === 0) {
      delete updated[document];
    } else {
      updated[document] = next;
    }

    setPreferences(updated);
  }

  const documents = [...PROJECT_DOCUMENTS].sort(
    (a, b) => PROJECT_DOCUMENT_ORDER[a] - PROJECT_DOCUMENT_ORDER[b],
  );

  return (
    <Card role="region" aria-labelledby="output-preferences-section-title">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle id="output-preferences-section-title">Export formats</CardTitle>
            <CardDescription>
              Choose the formats you want for each document. Only formats that suit a
              document&apos;s structure are offered. Nothing is generated yet — these are saved
              preferences.
            </CardDescription>
          </div>
          <SaveStatus state={state} message={message} />
        </div>
      </CardHeader>

      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            save({ outputPreferences: preferences });
          }}
        >
          <ul className="flex flex-col gap-3">
            {documents.map((document) => (
              <li key={document} className="rounded-md border border-border p-3">
                <fieldset>
                  <legend className="text-sm font-medium">
                    {PROJECT_DOCUMENT_ORDER[document]}. {PROJECT_DOCUMENT_LABELS[document]}
                  </legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {ALLOWED_FORMATS[document].map((format) => {
                      const checked = (preferences[document] ?? []).includes(format);

                      return (
                        <label
                          key={format}
                          className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs ${
                            checked ? 'border-accent bg-accent-soft' : 'border-border'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(document, format)}
                            className="size-3.5 rounded border-border"
                          />
                          {format}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              </li>
            ))}
          </ul>

          <Button type="submit" disabled={state === 'saving'} className="self-start">
            {state === 'saving' ? 'Saving…' : 'Save export formats'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
