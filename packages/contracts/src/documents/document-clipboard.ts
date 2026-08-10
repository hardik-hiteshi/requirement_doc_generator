import type { DocumentSection } from './document-section.contract';

/**
 * What lands on the clipboard.
 *
 * ## The client-facing copy is the document, and nothing else
 *
 * A reviewer copies Our Understanding to paste into an email, a proposal or a
 * message to the client. What must not travel with it: requirement ids, source
 * ids, page numbers, confidence figures, validation findings, version numbers,
 * generator metadata, section keys. Every one of those is *ours* — operational
 * detail that reads as noise at best and as internal process at worst.
 *
 * So the copy is built from titles and bodies. Not by stripping a rendered view —
 * by never including anything else in the first place, which is why this is a
 * function over the content rather than a DOM selection.
 *
 * A section the evidence did not support is omitted entirely rather than pasted as
 * a heading with an internal explanation underneath. "The approved requirements say
 * nothing about this" is a message for the person reviewing, not for the client.
 *
 * A line that opens with a requirement id — `REQ-014: Staff must sign in.` — loses
 * that opening. The id there is a citation somebody prefixed to a sentence, so
 * removing it leaves the sentence intact. An id *inside* a sentence is left alone
 * and reported instead: rewriting a reviewer's own words to hide an identifier would
 * change what the document says, and the honest move is to tell them it is there.
 * `leaksInternalData` is what the interface calls to do that.
 *
 * ## The technical copy exists, and is asked for explicitly
 *
 * `technicalDocumentText` includes the citations, because "which requirement does
 * this sentence come from?" is a real question in an internal review. It is a
 * separate function reached by a separate control, so the client-facing copy can
 * never accidentally become the technical one.
 */

/** Field names that must never appear in a client-facing copy. */
export const INTERNAL_ONLY_FIELDS: readonly string[] = [
  'sectionId',
  'key',
  'origin',
  'references',
  'proposedBody',
  'omittedReason',
  'regenerationReason',
  'recordVersion',
  'schemaVersion',
  'modelConfidence',
  'evidenceConfidence',
  'validation',
  'blockers',
];

export interface ClipboardDocument {
  readonly title: string;
  readonly sections: readonly Pick<DocumentSection, 'title' | 'body'>[];
}

/**
 * The document as a client would read it.
 *
 * Headings and prose, blank line between sections. Empty sections dropped.
 */
/** A requirement id used as a citation at the start of a line. */
const CITATION_PREFIX = /^\s*\bREQ-\d{3,5}\b\s*[:—–-]\s*/;

export function clientDocumentText(document: ClipboardDocument): string {
  const parts = [document.title];

  for (const section of document.sections) {
    const body = section.body
      .split('\n')
      .map((line) => line.replace(CITATION_PREFIX, ''))
      .join('\n')
      .trim();

    if (body.length === 0) {
      continue;
    }

    parts.push(`${section.title}\n${body}`);
  }

  return parts.join('\n\n');
}

/**
 * The same document with its citations, for an internal review.
 *
 * Requirement keys only — never a source id or a page number, because a citation a
 * reader cannot resolve is worse than none, and those belong to the evidence view
 * in the application rather than to a block of pasted text.
 */
export function technicalDocumentText(
  document: ClipboardDocument & {
    readonly sections: readonly (Pick<DocumentSection, 'title' | 'body'> & {
      readonly references?: readonly { readonly id: string }[];
    })[];
  },
): string {
  const parts = [document.title];

  for (const section of document.sections) {
    const body = section.body.trim();

    if (body.length === 0) {
      continue;
    }

    const cited = (section.references ?? []).map((reference) => reference.id);

    parts.push(
      cited.length > 0
        ? `${section.title}\n${body}\n[${cited.join(', ')}]`
        : `${section.title}\n${body}`,
    );
  }

  return parts.join('\n\n');
}

/**
 * Whether a block of text is safe to hand to a client.
 *
 * Checks for the shapes of our own identifiers rather than for a list of field
 * names: a leak arrives as `src_01H…` or `REQ-014` in the prose, not as the word
 * "sourceId". Used by the tests, and cheap enough to be worth asserting.
 */
export function leaksInternalData(text: string): readonly string[] {
  const found: string[] = [];

  const patterns: readonly { readonly pattern: RegExp; readonly label: string }[] = [
    { pattern: /\b(src|prj|doc|dsc|ftr|eu|esp|bsl|stk)_[0-9A-Z]{10,}/, label: 'an internal id' },
    { pattern: /\bREQ-\d{3,5}\b/, label: 'a requirement id' },
    { pattern: /\bEST-\d{3,5}\b/, label: 'an estimate id' },
    {
      pattern: /"(sectionId|origin|recordVersion|evidenceConfidence|modelConfidence)"/,
      label: 'a stored field name',
    },
    { pattern: /\bmodelConfidence\b|\bevidenceConfidence\b/, label: 'a confidence figure' },
    { pattern: /\b(BLOCKING|DETERMINISTIC|USER_EDITED|GENERATED)\b/, label: 'an internal status' },
  ];

  for (const { pattern, label } of patterns) {
    if (pattern.test(text)) {
      found.push(label);
    }
  }

  return found;
}
