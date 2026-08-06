/**
 * Response headers sent by the web application for every route.
 *
 * Kept out of `next.config.ts` so the set is importable by a test — a header
 * list that is only asserted in a document is a header list that silently
 * regresses.
 *
 * ## Content-Security-Policy is deliberately absent
 *
 * There is no CSP here. Writing one now would mean guessing the runtime origins
 * the application will need — object storage for uploads and exports, a CAPTCHA
 * provider, whatever analytics is chosen — and a CSP written against a guess is
 * one that gets switched off the first time it breaks a feature. It is Phase 12
 * work, alongside the rest of the abuse controls.
 *
 * The API sets helmet's default CSP on its own responses in production. That
 * protects the API's responses; it does nothing for this application's HTML.
 */
export interface SecurityHeader {
  readonly key: string;
  readonly value: string;
}

export const SECURITY_HEADERS: readonly SecurityHeader[] = [
  // Stop the browser second-guessing declared content types.
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // The workspace is never legitimately framed.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Send the origin cross-site, the full path same-origin.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  // Nothing here needs these capabilities; deny them up front.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },
];
