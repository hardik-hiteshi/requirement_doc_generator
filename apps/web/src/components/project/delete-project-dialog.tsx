'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectResponse } from '@wdrg/contracts';
import { Button, Field, Input } from '@wdrg/ui';
import { useEffect, useRef, useState } from 'react';

import { ApiClientError } from '@/lib/api-client';
import { deleteProject } from '@/lib/project-api';
import { queryKeys } from '@/lib/query-keys';

export interface DeleteProjectDialogProps {
  readonly project: ProjectResponse;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onDeleted: () => void;
}

/**
 * Deletion confirmation.
 *
 * Built on the native `<dialog>` element, which gives focus trapping, `Escape`
 * to close and the correct `role="dialog"` semantics without a custom
 * implementation that would get them subtly wrong.
 *
 * The user must type the project name. On an account-less product there is no
 * support path to restore a deletion, so a single click is not enough
 * commitment for an irreversible action.
 */
export function DeleteProjectDialog({
  project,
  open,
  onClose,
  onDeleted,
}: DeleteProjectDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | undefined>();
  const queryClient = useQueryClient();

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () => deleteProject({ version: project.version, confirmationName: confirmation }),
    onSuccess: () => {
      // The API has already cleared the session cookie; drop the cached project
      // so the workspace cannot render stale data behind the dialog.
      queryClient.setQueryData(queryKeys.currentProject, undefined);
      queryClient.removeQueries({ queryKey: queryKeys.currentProject });
      onDeleted();
    },
    onError: (caught: unknown) => {
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : 'The project could not be deleted. Please try again.',
      );
    },
  });

  const nameMatches =
    confirmation.trim().toLocaleLowerCase() === project.name.trim().toLocaleLowerCase();

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="delete-dialog-title"
      aria-describedby="delete-dialog-description"
      onClose={onClose}
      className="max-w-lg rounded-lg border border-border bg-surface p-0 text-foreground backdrop:bg-black/40"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          setError(undefined);
          mutation.mutate();
        }}
      >
        <h2 id="delete-dialog-title" className="text-lg font-semibold">
          Delete this project?
        </h2>

        <p id="delete-dialog-description" className="text-sm text-muted">
          This deletes <strong className="text-foreground">{project.name}</strong> and everything in
          it. Every open session ends and the recovery link stops working immediately — nobody,
          including support, can restore it.
        </p>

        <Field
          label={`Type the project name to confirm`}
          hint={project.name}
          required
          error={error}
        >
          {(props) => (
            <Input
              {...props}
              value={confirmation}
              autoComplete="off"
              onChange={(event) => setConfirmation(event.target.value)}
            />
          )}
        </Field>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Keep project
          </Button>
          <Button type="submit" variant="danger" disabled={!nameMatches || mutation.isPending}>
            {mutation.isPending ? 'Deleting…' : 'Delete permanently'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
