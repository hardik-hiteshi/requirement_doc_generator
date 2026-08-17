import type { Metadata } from 'next';

import { OperatorConsole } from '@/components/admin/operator-console';

/**
 * The operator console.
 *
 * `noindex` because this page exists for whoever runs the deployment, not for anyone
 * who might find it. It reveals nothing without a token — the API answers 404 when the
 * surface is disabled and 401 otherwise — but a page that advertises where the operator
 * surface lives is still a page worth not advertising.
 */
export const metadata: Metadata = {
  title: 'Operator console',
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return (
    <main id="main-content" className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Operations</h1>
      <OperatorConsole />
    </main>
  );
}
