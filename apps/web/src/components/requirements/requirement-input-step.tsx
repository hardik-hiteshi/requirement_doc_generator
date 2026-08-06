'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useState } from 'react';

import { useSource, useSources } from '@/hooks/use-sources';
import { PasteTextPanel } from './paste-text-panel';
import { ReviewPanel } from './review-panel';
import { SourceList } from './source-list';
import { UploadPanel } from './upload-panel';

/**
 * The requirement-input step.
 *
 * Composition only: every piece below owns its own state and its own mutations.
 * What lives here is the one thing that spans them — which source is open — and
 * it lives here because both the list and the review panel need it and neither
 * owns the other.
 */
export function RequirementInputStep() {
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const { data, isPending, isError } = useSources();
  const { data: selected } = useSource(selectedId);

  if (isPending) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="text-sm text-muted">Loading your requirement sources…</p>
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="p-5">
          <p role="alert" className="text-sm text-danger">
            Your requirement sources could not be loaded. Reload the page to try again.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Requirement input</CardTitle>
          <CardDescription>
            Add everything the client has given you. Each source keeps its own page, row or line
            references, so every requirement can be traced back to where it came from.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted">
          Nothing is analysed yet. Reading the content is this step; understanding it — modules,
          features, conflicts and gaps — is the next one, which is not built yet.
        </CardContent>
      </Card>

      <PasteTextPanel />
      <UploadPanel usage={data.usage} />

      <SourceList
        sources={data.sources}
        selectedId={selectedId}
        onSelect={(sourceId) => setSelectedId(sourceId)}
      />

      {selected ? <ReviewPanel source={selected} /> : null}
    </div>
  );
}
