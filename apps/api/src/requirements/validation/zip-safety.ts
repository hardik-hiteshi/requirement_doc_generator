/**
 * Reading a ZIP container's directory without decompressing anything.
 *
 * DOCX and XLSX are ZIP archives, which makes them a decompression-bomb vector:
 * a 40 KB file can legitimately declare petabytes of output, and a parser handed
 * one will dutifully try. The defence has to happen *before* the parser sees the
 * file, and it has to work from declared metadata rather than by decompressing
 * and measuring — measuring is the attack.
 *
 * So this walks the central directory, which sits at the end of every ZIP and
 * lists each entry's compressed and uncompressed sizes, and adds them up. No
 * entry is inflated. The check is a bound on what the file *claims* it will
 * expand to, which is exactly the number a bomb has to lie about to be one.
 */

export type ZipRejection =
  'malformed' | 'encrypted' | 'expansion_limit' | 'ratio_limit' | 'too_many_entries';

export type ZipInspection =
  | { readonly ok: true; readonly entryCount: number; readonly uncompressedBytes: number }
  | { readonly ok: false; readonly reason: ZipRejection };

/** End-of-central-directory signature: `PK\x05\x06`. */
const EOCD_SIGNATURE = 0x06054b50;
/** Central-directory file-header signature: `PK\x01\x02`. */
const CENTRAL_SIGNATURE = 0x02014b50;

/** An office document with more parts than this is not a document. */
const MAX_ENTRIES = 5_000;

/**
 * Compression ratio ceiling.
 *
 * Real office documents contain XML, which compresses well — 20:1 is ordinary
 * and 60:1 happens for a large, repetitive spreadsheet. A bomb is several
 * thousand to one. This sits far above legitimate use and far below an attack.
 */
const MAX_RATIO = 200;

export function inspectZipContainer(content: Buffer, maxUncompressedBytes: number): ZipInspection {
  const eocd = findEndOfCentralDirectory(content);

  if (eocd === -1) {
    return { ok: false, reason: 'malformed' };
  }

  const entryCount = content.readUInt16LE(eocd + 10);
  const directorySize = content.readUInt32LE(eocd + 12);
  const directoryOffset = content.readUInt32LE(eocd + 16);

  if (entryCount > MAX_ENTRIES) {
    return { ok: false, reason: 'too_many_entries' };
  }

  if (directoryOffset + directorySize > content.length) {
    return { ok: false, reason: 'malformed' };
  }

  let offset = directoryOffset;
  let uncompressedBytes = 0;
  let compressedBytes = 0;

  for (const _entry of Array.from({ length: entryCount })) {
    // Each header is at least 46 bytes before its variable-length name.
    if (offset + 46 > content.length) {
      return { ok: false, reason: 'malformed' };
    }

    if (content.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      return { ok: false, reason: 'malformed' };
    }

    const flags = content.readUInt16LE(offset + 8);

    // Bit 0 of the general-purpose flags means the entry is encrypted. Office
    // documents protected with a password set this, and no parser here can open
    // one — better to say so than to fail obscurely later.
    if ((flags & 0x0001) !== 0) {
      return { ok: false, reason: 'encrypted' };
    }

    compressedBytes += content.readUInt32LE(offset + 20);
    uncompressedBytes += content.readUInt32LE(offset + 24);

    if (uncompressedBytes > maxUncompressedBytes) {
      return { ok: false, reason: 'expansion_limit' };
    }

    const nameLength = content.readUInt16LE(offset + 28);
    const extraLength = content.readUInt16LE(offset + 30);
    const commentLength = content.readUInt16LE(offset + 32);

    offset += 46 + nameLength + extraLength + commentLength;
  }

  // Guard the ratio as well as the total: a small declared total with an absurd
  // ratio is the same attack scaled down to slip under an absolute limit.
  if (compressedBytes > 0 && uncompressedBytes / compressedBytes > MAX_RATIO) {
    return { ok: false, reason: 'ratio_limit' };
  }

  return { ok: true, entryCount, uncompressedBytes };
}

/**
 * Locates the end-of-central-directory record.
 *
 * It is the last thing in the file, but a trailing comment of up to 64 KB may
 * follow it, so the tail has to be scanned backwards rather than read at a fixed
 * offset.
 */
function findEndOfCentralDirectory(content: Buffer): number {
  const minimumRecord = 22;

  if (content.length < minimumRecord) {
    return -1;
  }

  const searchFrom = Math.max(0, content.length - (minimumRecord + 0xffff));

  for (let offset = content.length - minimumRecord; offset >= searchFrom; offset -= 1) {
    if (content.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }

  return -1;
}

/**
 * Entity declarations in XML, which is what an XXE attack needs.
 *
 * The libraries used here do not resolve external entities, so this is a second
 * line rather than the control. It exists because "the library is safe" is a
 * claim about a version, and a dependency bump should not be able to silently
 * turn it false.
 */
export function containsXmlEntityDeclaration(xml: string): boolean {
  return /<!ENTITY\s/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml);
}
