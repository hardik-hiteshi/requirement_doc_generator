'use client';

import { SOURCE_LIMITS } from '@wdrg/contracts';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Textarea,
} from '@wdrg/ui';
import { useState } from 'react';

import { ApiClientError } from '@/lib/api-client';
import { addTextSource } from '@/lib/requirements-api';
import { useSourceMutation } from '@/hooks/use-sources';

/**
 * Pasted requirement text.
 *
 * Deliberately as prominent as the upload area. Most requirement conversations
 * start as an email or a chat message, and forcing someone to save that as a
 * file before the product will read it is friction with no purpose.
 */
export function PasteTextPanel() {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();

  const mutation = useSourceMutation(addTextSource);

  const remaining = SOURCE_LIMITS.text.max - text.length;
  const tooLong = remaining < 0;

  return (
    <Card role="region" aria-labelledby="paste-text-title">
      <CardHeader>
        <CardTitle id="paste-text-title">Paste requirement text</CardTitle>
        <CardDescription>
          Notes, an email, a chat transcript — anything the client has told you. Each paste becomes
          its own requirement source you can review and edit.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            setError(undefined);

            mutation.mutate(
              { title: title.trim(), text },
              {
                onSuccess: () => {
                  setTitle('');
                  setText('');
                },
                onError: (caught: unknown) => {
                  setError(
                    caught instanceof ApiClientError
                      ? caught.message
                      : 'The text could not be saved. Please try again.',
                  );
                },
              },
            );
          }}
        >
          <Field label="Source title" required>
            {(props) => (
              <Input
                {...props}
                value={title}
                maxLength={SOURCE_LIMITS.title.max}
                placeholder="Kick-off call notes"
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Requirement text"
            required
            hint={`Up to ${SOURCE_LIMITS.text.max.toLocaleString()} characters.`}
            error={tooLong ? 'This text is longer than the limit.' : undefined}
          >
            {(props) => (
              <Textarea
                {...props}
                rows={10}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            )}
          </Field>

          <p className="text-xs text-muted" role="status">
            {text.length.toLocaleString()} characters
            {tooLong ? ` — ${Math.abs(remaining).toLocaleString()} over the limit` : ''}
          </p>

          {error ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            disabled={
              mutation.isPending || title.trim().length === 0 || text.length === 0 || tooLong
            }
            className="self-start"
          >
            {mutation.isPending ? 'Saving…' : 'Add requirement text'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
