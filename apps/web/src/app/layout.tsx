import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { AppProviders } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Requirement Documentation Generator',
  description:
    'Turn client requirements into an approved baseline, effort estimation and seven project documents.',
  // The workspace is a private, per-project surface; it should not be indexed.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Bypasses the workflow navigator for keyboard and screen-reader users. */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-foreground"
        >
          Skip to main content
        </a>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
