/**
 * Comparing requirement text without asking a model.
 *
 * Used for two things the application must be able to do for itself.
 *
 * **Verifying a citation.** When the model says a requirement came from "the
 * system must send a quote within 24 hours", that quotation is checked against
 * the block it cited. A model marking its own homework is not evidence, and this
 * is what turns `verified: true` into a fact.
 *
 * **Finding exact and near duplicates.** The model finds *restated* duplicates —
 * different words, same requirement — which needs understanding. Identical and
 * near-identical text does not, and computing it here means the obvious cases
 * are found reliably, for free, and identically every run.
 *
 * Everything here is deterministic. The same two strings always produce the same
 * number, which is what lets a similarity score be stored and trusted later.
 */

/**
 * Normalises text for comparison.
 *
 * Case, punctuation and whitespace are removed because a requirement restated
 * with a different comma is the same requirement. Smart quotes and dashes are
 * folded because they differ between a PDF and the DOCX it was made from, and
 * "these two documents say the same thing" must not depend on which one the
 * typesetter touched.
 */
export function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Content words, with the ones that carry no meaning on their own removed. */
export function tokenize(text: string): string[] {
  return normalizeForComparison(text)
    .split(' ')
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

/**
 * Words removed before comparison.
 *
 * Deliberately short. A longer list would be tempting — but `must`, `shall`,
 * `not` and `all` change what a requirement *means*, and dropping them makes
 * "the system must not delete records" look like "the system must delete
 * records". Only words that carry no requirement meaning are here.
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'for',
  'with',
  'as',
  'is',
  'are',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'and',
  'or',
]);

/**
 * How much of the shorter text's meaning the longer one contains.
 *
 * Jaccard over content-word sets, which is symmetric, cheap and good enough for
 * the job it does here: telling "these are obviously the same sentence" from
 * "these are different sentences about the same feature". The second case is the
 * model's job, and this deliberately does not try to do it.
 */
export function similarity(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));

  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const token of left) {
    if (right.has(token)) {
      shared += 1;
    }
  }

  const union = left.size + right.size - shared;

  return union === 0 ? 0 : round(shared / union);
}

/** Above this, two normalised statements are the same requirement. */
export const EXACT_DUPLICATE_THRESHOLD = 1;
/** Above this, they are near-duplicates worth showing a reviewer. */
export const NEAR_DUPLICATE_THRESHOLD = 0.85;

/** How a quoted excerpt relates to the block it claims to come from. */
export type ExcerptSupport = 'verbatim' | 'partial' | 'absent';

/**
 * Checks a model's quotation against the real text of the block it cited.
 *
 * `verbatim` after normalisation — not character-identical, because a model
 * reliably reproduces the words and unreliably reproduces the whitespace, and
 * failing a correct citation over a double space would teach reviewers to
 * ignore the signal.
 *
 * `partial` when most of the quoted content words are present. This covers the
 * common real case of a model quoting across an ellipsis or dropping a
 * parenthetical, and it is scored lower than verbatim rather than treated the
 * same.
 */
export function checkExcerpt(excerpt: string, blockText: string): ExcerptSupport {
  const normalizedExcerpt = normalizeForComparison(excerpt);
  const normalizedBlock = normalizeForComparison(blockText);

  if (normalizedExcerpt.length === 0) {
    return 'absent';
  }

  if (normalizedBlock.includes(normalizedExcerpt)) {
    return 'verbatim';
  }

  const excerptTokens = tokenize(excerpt);

  if (excerptTokens.length === 0) {
    return 'absent';
  }

  const blockTokens = new Set(tokenize(blockText));
  const present = excerptTokens.filter((token) => blockTokens.has(token)).length;

  return present / excerptTokens.length >= PARTIAL_SUPPORT_THRESHOLD ? 'partial' : 'absent';
}

/** Most of the quoted words, not merely some. */
export const PARTIAL_SUPPORT_THRESHOLD = 0.7;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
