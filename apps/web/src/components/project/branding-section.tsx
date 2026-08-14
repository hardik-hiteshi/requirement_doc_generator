'use client';

import {
  ACCENT_COLOR_PATTERN,
  BRANDING_LIMITS,
  DEFAULT_BRANDING,
  NEUTRAL_ACCENT,
  type Branding,
  type ProjectResponse,
} from '@wdrg/contracts';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@wdrg/ui';
import { useRef, useState } from 'react';

import { useSectionSave } from '@/hooks/use-project';
import { updateBranding, uploadBrandingLogo } from '@/lib/project-api';
import { SaveStatus } from './save-status';

/**
 * How exported documents look, set once for the project.
 *
 * Here rather than on each document, because seven copies of the same question produce
 * seven answers and a set of exports that disagree with each other.
 *
 * The section says plainly that this is presentation. People are reasonably wary of
 * touching anything near an approved document, and the reassurance is true: changing
 * branding cannot move a version or make anything out of date.
 */
export function BrandingSection({ project }: { project: ProjectResponse }) {
  const [branding, setBranding] = useState<Branding>(() => project.branding ?? DEFAULT_BRANDING);
  const [logoError, setLogoError] = useState<string | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const { save, state, message } = useSectionSave<{ branding: Branding }>({
    mutate: updateBranding,
  });

  const accentValid =
    branding.accentColor === undefined || ACCENT_COLOR_PATTERN.test(branding.accentColor);

  function set<K extends keyof Branding>(key: K, value: Branding[K]): void {
    setBranding((current) => {
      const next = { ...current };

      /* An empty field means "not configured", which is not the same as an empty string. */
      if (value === undefined || value === '') {
        delete next[key];
      } else {
        next[key] = value;
      }

      return next;
    });
  }

  async function chooseLogo(file: File | undefined): Promise<void> {
    if (!file) {
      return;
    }

    setLogoError(undefined);
    setUploading(true);

    try {
      const { logo } = await uploadBrandingLogo(file);

      set('logo', logo);
    } catch (error) {
      /*
       * The upload failing must not lose what is already on screen, and must not read as
       * a document problem — it is a logo problem, and the rest of the form is intact.
       */
      setLogoError(
        error instanceof Error ? error.message : 'That file could not be used as a logo.',
      );
    } finally {
      setUploading(false);

      if (fileInput.current) {
        fileInput.current.value = '';
      }
    }
  }

  return (
    <Card role="region" aria-label="Document branding">
      <CardHeader>
        <CardTitle>Document branding</CardTitle>
        <CardDescription>
          How exported files look. This is presentation only — changing it never alters a document,
          its version, or whether it is up to date. Leave it empty for a clean, unbranded default.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="branding-organization">
            Organisation name
          </label>
          <input
            id="branding-organization"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            maxLength={BRANDING_LIMITS.organizationName}
            value={branding.organizationName ?? ''}
            onChange={(event) => set('organizationName', event.target.value)}
            data-testid="branding-organization"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="branding-footer">
            Footer note
          </label>
          <input
            id="branding-footer"
            className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            maxLength={BRANDING_LIMITS.footerText}
            placeholder="Commercial in confidence"
            value={branding.footerText ?? ''}
            onChange={(event) => set('footerText', event.target.value)}
            data-testid="branding-footer"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="branding-accent">
            Accent colour
          </label>
          <div className="flex items-center gap-2">
            <input
              id="branding-accent"
              className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
              placeholder={NEUTRAL_ACCENT}
              value={branding.accentColor ?? ''}
              onChange={(event) => set('accentColor', event.target.value)}
              aria-invalid={!accentValid}
              aria-describedby={accentValid ? undefined : 'branding-accent-error'}
              data-testid="branding-accent"
            />
            <span
              aria-hidden="true"
              className="size-8 shrink-0 rounded-md border border-border"
              style={{
                background: accentValid ? (branding.accentColor ?? NEUTRAL_ACCENT) : 'transparent',
              }}
              data-testid="branding-accent-preview"
            />
          </div>
          {!accentValid && (
            <p
              className="text-sm text-danger"
              id="branding-accent-error"
              data-testid="branding-accent-error"
            >
              Use a six-digit hex colour such as {NEUTRAL_ACCENT}.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Logo</span>
          <p className="text-sm text-muted">
            PNG or JPEG, up to 2 MB. Checked and scanned like any other upload.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              className="text-sm"
              aria-label="Choose a logo file"
              disabled={uploading}
              onChange={(event) => void chooseLogo(event.target.files?.[0])}
              data-testid="branding-logo-input"
            />
            {branding.logo && (
              <>
                <span className="text-sm text-muted" data-testid="branding-logo-name">
                  {branding.logo.filename}
                </span>
                <Button
                  variant="secondary"
                  onClick={() => set('logo', undefined)}
                  data-testid="branding-logo-remove"
                >
                  Remove logo
                </Button>
              </>
            )}
          </div>
          {logoError && (
            <p className="text-sm text-danger" role="alert" data-testid="branding-logo-error">
              {logoError}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void save({ branding })}
            disabled={!accentValid || uploading}
            data-testid="branding-save"
          >
            Save branding
          </Button>
          <Button
            variant="secondary"
            onClick={() => setBranding(DEFAULT_BRANDING)}
            data-testid="branding-reset"
          >
            Reset to default
          </Button>
          <SaveStatus state={state} message={message} />
        </div>
      </CardContent>
    </Card>
  );
}
