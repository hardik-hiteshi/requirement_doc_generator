'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import {
  createProjectRequestSchema,
  MAX_PROJECT_TYPES,
  PROJECT_TYPES,
  PROJECT_TYPE_DESCRIPTIONS,
  PROJECT_TYPE_LABELS,
  type CreateProjectRequest,
  type ProjectCreatedResponse,
  type ProjectType,
} from '@wdrg/contracts';
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
import { useForm } from 'react-hook-form';

import { ApiClientError } from '@/lib/api-client';
import { createProject } from '@/lib/project-api';

export interface CreateProjectPanelProps {
  /**
   * Hands the created project — and its one-and-only view of the recovery
   * secret — to the owner of the screen.
   */
  readonly onCreated: (response: ProjectCreatedResponse) => void;
}

/**
 * Project creation.
 *
 * The same schema the API validates against also drives this form, so a rule is
 * enforced in the browser and on the server without being written twice — and
 * cannot drift between them.
 *
 * This panel deliberately does **not** put the new project into the query cache.
 * Doing so would tell the workspace it now has a project, which would unmount
 * this panel — taking the recovery link with it before the user had a chance to
 * save it. The recovery link outranks this component's own lifecycle, so it is
 * owned one level up.
 */
export function CreateProjectPanel({ onCreated }: CreateProjectPanelProps) {
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [selectedTypes, setSelectedTypes] = useState<ProjectType[]>([]);

  const form = useForm<CreateProjectRequest>({
    resolver: zodResolver(createProjectRequestSchema),
    defaultValues: { name: '' },
  });

  const mutation = useMutation({
    mutationFn: createProject,
    onSuccess: onCreated,
    onError: (error: unknown) => {
      setSubmitError(
        error instanceof ApiClientError
          ? error.message
          : 'The project could not be created. Please try again.',
      );
    },
  });

  function toggleType(type: ProjectType) {
    setSelectedTypes((current) =>
      current.includes(type)
        ? current.filter((value) => value !== type)
        : current.length < MAX_PROJECT_TYPES
          ? [...current, type]
          : current,
    );
  }

  return (
    <Card role="region" aria-labelledby="create-project-title">
      <CardHeader>
        <CardTitle id="create-project-title">Start a new project</CardTitle>
        <CardDescription>
          No account needed. You will receive a reusable private recovery link — it is the only way
          back into this project, and it is shown to you only once.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            // handleSubmit returns a promise; onSubmit expects void. Voiding it
            // explicitly keeps the floating-promise rule meaningful elsewhere.
            void form.handleSubmit((values) => {
              setSubmitError(undefined);
              mutation.mutate({
                ...values,
                ...(selectedTypes.length > 0 ? { projectTypes: selectedTypes } : {}),
              });
            })(event);
          }}
        >
          <Field label="Project name" required error={form.formState.errors.name?.message}>
            {(props) => (
              <Input
                {...props}
                {...form.register('name')}
                placeholder="Acme customer portal"
                autoComplete="off"
              />
            )}
          </Field>

          <Field label="Client name" error={form.formState.errors.clientName?.message}>
            {(props) => <Input {...props} {...form.register('clientName')} autoComplete="off" />}
          </Field>

          <Field
            label="Internal reference"
            hint="Your own tracking number, if you use one."
            error={form.formState.errors.internalReference?.message}
          >
            {(props) => (
              <Input {...props} {...form.register('internalReference')} autoComplete="off" />
            )}
          </Field>

          <Field
            label="Project description or notes"
            hint="Anything that helps describe the work. Requirement documents are added later."
            error={form.formState.errors.description?.message}
          >
            {(props) => <Textarea {...props} {...form.register('description')} rows={4} />}
          </Field>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-foreground">
              Project type
              <span className="ml-2 text-xs font-normal text-muted">(optional for now)</span>
            </legend>
            <p className="text-xs text-muted">
              Select up to {MAX_PROJECT_TYPES}. This shapes the technology stack, roles, estimate
              and documents in later steps, so it is required before the technology-stack step — you
              can set it now or later.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {PROJECT_TYPES.map((type) => {
                const checked = selectedTypes.includes(type);
                const atLimit = !checked && selectedTypes.length >= MAX_PROJECT_TYPES;

                return (
                  <label
                    key={type}
                    className={`flex items-start gap-2.5 rounded-md border p-2.5 text-sm ${
                      checked ? 'border-accent bg-accent-soft' : 'border-border'
                    } ${atLimit ? 'opacity-50' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={atLimit}
                      onChange={() => toggleType(type)}
                      className="mt-0.5 size-4 shrink-0 rounded border-border"
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">{PROJECT_TYPE_LABELS[type]}</span>
                      <span className="text-xs text-muted">{PROJECT_TYPE_DESCRIPTIONS[type]}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {submitError ? (
            <p role="alert" className="text-sm font-medium text-danger">
              {submitError}
            </p>
          ) : null}

          <Button type="submit" size="lg" disabled={mutation.isPending} className="self-start">
            {mutation.isPending ? 'Creating project…' : 'Create project'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
