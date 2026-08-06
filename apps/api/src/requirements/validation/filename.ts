import { basename } from 'node:path';

/**
 * Making a client-supplied filename safe to keep and safe to show.
 *
 * Two separate jobs, and conflating them is where filename bugs come from:
 *
 * - **Safety** is structural. It is achieved by never using this value as a
 *   path: stored objects are addressed by an application-minted id, so
 *   `../../etc/passwd` has nowhere to escape *to*. The checks below are a second
 *   line, not the first.
 * - **Display** is cosmetic. A name full of control characters renders badly,
 *   and one containing a right-to-left override can render as a completely
 *   different name from the one it has — the classic trick turns an executable
 *   into something that looks like an image. Those are refused before anything
 *   shows the name.
 *
 * The original is always retained verbatim. A user who uploaded `Rapport été.pdf`
 * should still see that, and an operator investigating an upload needs what was
 * actually sent, not a cleaned-up version of it.
 */

/** Why a filename was refused outright. */
export type FilenameRejection =
  'empty' | 'too_long' | 'path_traversal' | 'control_characters' | 'reserved_name' | 'no_extension';

export interface FilenameResult {
  readonly ok: boolean;
  readonly rejection?: FilenameRejection;
  /** Safe for display. Never used to build a path. */
  readonly display: string;
  /** Lower-case, without the dot. Empty when there is no extension. */
  readonly extension: string;
}

/**
 * Windows device names. Harmless on Linux, but a downloaded `CON.pdf` is
 * genuinely awkward on a Windows client, and rejecting is cheaper than
 * discovering it later.
 */
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

// C0 and C1 controls, plus the bidirectional overrides that let a filename
// display as something other than what it is.
// eslint-disable-next-line no-control-regex -- exactly the characters at issue
const UNSAFE_CHARACTERS = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

const PATH_SEPARATORS = /[/\\]/;

export function extensionOf(filename: string): string {
  const lastDot = filename.lastIndexOf('.');

  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return '';
  }

  return filename.slice(lastDot + 1).toLowerCase();
}

/**
 * Checks a filename and produces a safe display form.
 *
 * Traversal is rejected rather than sanitised. A name containing `..` or a path
 * separator is either an attack or a client bug, and quietly repairing it would
 * hide both — the user gets told, and the log gets the original.
 */
export function normalizeFilename(raw: string, maxLength: number): FilenameResult {
  const failed = (rejection: FilenameRejection): FilenameResult => ({
    ok: false,
    rejection,
    display: '',
    extension: '',
  });

  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return failed('empty');
  }

  if (raw.length > maxLength) {
    return failed('too_long');
  }

  if (UNSAFE_CHARACTERS.test(trimmed)) {
    return failed('control_characters');
  }

  if (PATH_SEPARATORS.test(trimmed) || trimmed.includes('..')) {
    return failed('path_traversal');
  }

  // Defence in depth: even having rejected separators, take the basename. If the
  // two ever disagree, something got past the check above.
  const base = basename(trimmed);

  if (base !== trimmed || base === '.' || base === '..') {
    return failed('path_traversal');
  }

  const extension = extensionOf(base);

  if (extension.length === 0) {
    return failed('no_extension');
  }

  const stem = base.slice(0, base.length - extension.length - 1);

  if (RESERVED_NAMES.has(stem.toLowerCase())) {
    return failed('reserved_name');
  }

  return { ok: true, display: collapseWhitespace(base), extension };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Every extension in a name, first to last.
 *
 * `report.pdf.exe` is the classic double extension: the *effective* extension is
 * the last one, and the earlier one is decoration meant to reassure a human. The
 * pipeline validates the last, so this exists to let the caller notice the trick
 * and say so, rather than silently accepting an `.exe`.
 */
export function allExtensions(filename: string): string[] {
  const parts = filename.split('.').slice(1);
  return parts.map((part) => part.toLowerCase()).filter((part) => /^[a-z0-9]{1,10}$/.test(part));
}

/** True when the name carries more than one plausible extension. */
export function hasMultipleExtensions(filename: string): boolean {
  return allExtensions(filename).length > 1;
}
