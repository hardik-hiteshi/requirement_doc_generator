/**
 * Making text that a spreadsheet would execute read as text.
 *
 * Excel, LibreOffice Calc and Google Sheets all treat a cell beginning `=`, `+`, `-` or
 * `@` as a formula, and quoting does not change that: quoting is CSV's escaping, applied
 * before the spreadsheet ever sees the value, and `"=1+1"` still opens as a formula.
 * `=HYPERLINK(...)` or `=cmd|...` in a feature description is therefore a real hazard in
 * a file that gets mailed to a client and opened without a thought.
 *
 * Two further characters matter for the same reason: tab and carriage return can begin a
 * cell that a spreadsheet then re-parses, so they are treated as dangerous leads too.
 *
 * The fix has to be narrow. A description legitimately beginning "-5% margin" or a module
 * called "@Home" must survive recognisably, and an ordinary value must come out byte for
 * byte unchanged — an export that quietly rewrites content is worse than the injection it
 * was guarding against.
 */

/** The leads a spreadsheet reads as "this is not text". */
const DANGEROUS_LEADS = ['=', '+', '-', '@', '\t', '\r'] as const;

/**
 * A zero-width prefix would be invisible but also alters the string every consumer sees.
 * A leading apostrophe is the convention spreadsheets themselves use for "literal text",
 * and it is what a person typing into Excel would do.
 */
const LITERAL_PREFIX = "'";

export function looksLikeFormula(value: string): boolean {
  const lead = value.charAt(0);

  return (DANGEROUS_LEADS as readonly string[]).includes(lead);
}

/**
 * The value as it should appear in a spreadsheet cell.
 *
 * Ordinary text is returned untouched — same object, same bytes — so this can be applied
 * across every column without auditing what it did to values that were never at risk.
 */
export function spreadsheetSafeText(value: string): string {
  if (value.length === 0 || !looksLikeFormula(value)) {
    return value;
  }

  return `${LITERAL_PREFIX}${value}`;
}

/**
 * Whether a cell has been neutralised, for tests and for reading a value back.
 *
 * A consumer that wants the original text can strip one leading apostrophe; anything
 * relying on that should use `spreadsheetOriginalText` rather than slicing by hand.
 */
export function isNeutralised(value: string): boolean {
  return value.startsWith(LITERAL_PREFIX) && looksLikeFormula(value.slice(1));
}

export function spreadsheetOriginalText(value: string): string {
  return isNeutralised(value) ? value.slice(1) : value;
}
