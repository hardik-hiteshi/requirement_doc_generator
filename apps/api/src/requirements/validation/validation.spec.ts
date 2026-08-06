import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AppConfigService } from '../../config/app-config.service';
import {
  detectSignature,
  looksEncryptedPdf,
  looksLikeText,
  verifySignature,
} from './content-signature';
import { FileValidator, checksumOf } from './file-validator';
import { allExtensions, extensionOf, hasMultipleExtensions, normalizeFilename } from './filename';
import { containsXmlEntityDeclaration, inspectZipContainer } from './zip-safety';

/**
 * The upload gate.
 *
 * These are the tests that matter most in this phase. Everything downstream —
 * storage, parsing, OCR — assumes the bytes it is handed are what they claim to
 * be, and this is the only place that assumption is established.
 */

const FIXTURES = join(__dirname, '..', '..', '..', 'test', 'fixtures');
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));

function makeValidator(overrides: Record<string, unknown> = {}): FileValidator {
  return new FileValidator({
    upload: {
      maxFileBytes: 26_214_400,
      maxFilenameLength: 255,
      ...(overrides.upload as object),
    },
    extraction: { maxUncompressedBytes: 209_715_200 },
    legacyConversion: { enabled: false, ...(overrides.legacyConversion as object) },
  } as unknown as AppConfigService);
}

describe('filename normalisation', () => {
  it.each([
    ['../../etc/passwd', 'path_traversal'],
    ['..\\..\\windows\\system32\\cmd.exe', 'path_traversal'],
    ['sub/dir/report.pdf', 'path_traversal'],
    ['report..pdf', 'path_traversal'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['report', 'no_extension'],
    ['CON.pdf', 'reserved_name'],
  ])('refuses %p as %s', (filename, rejection) => {
    const result = normalizeFilename(filename, 255);

    expect(result.ok).toBe(false);
    expect(result.rejection).toBe(rejection);
  });

  it('refuses a name containing a control character', () => {
    const result = normalizeFilename('report\u0007.pdf', 255);

    expect(result.ok).toBe(false);
    expect(result.rejection).toBe('control_characters');
  });

  it('refuses a right-to-left override, which disguises the real extension', () => {
    // Renders as "invoicefdp.exe" reversed — the classic disguise for an
    // executable, and the reason this is refused rather than merely stripped.
    const result = normalizeFilename('invoice\u202Egpj.exe', 255);

    expect(result.ok).toBe(false);
    expect(result.rejection).toBe('control_characters');
  });

  it('refuses a name longer than the limit', () => {
    expect(normalizeFilename(`${'a'.repeat(300)}.pdf`, 255).rejection).toBe('too_long');
  });

  it('accepts an ordinary name and keeps its characters', () => {
    const result = normalizeFilename('Rapport été 2026.pdf', 255);

    expect(result.ok).toBe(true);
    expect(result.display).toBe('Rapport été 2026.pdf');
    expect(result.extension).toBe('pdf');
  });

  it('takes the last extension, which is the one that decides', () => {
    expect(extensionOf('report.pdf.exe')).toBe('exe');
    expect(allExtensions('report.pdf.exe')).toEqual(['pdf', 'exe']);
    expect(hasMultipleExtensions('report.pdf.exe')).toBe(true);
    expect(hasMultipleExtensions('report.pdf')).toBe(false);
  });
});

describe('content signatures', () => {
  it.each([
    ['requirements-digital.pdf', 'pdf'],
    ['requirements.docx', 'zip'],
    ['features.xlsx', 'zip'],
    ['printed-requirements.png', 'png'],
    ['printed-requirements.jpg', 'jpg'],
  ])('recognises %s as %s', (name, expected) => {
    expect(detectSignature(fixture(name))).toBe(expected);
  });

  it('names a Windows executable rather than shrugging', () => {
    expect(detectSignature(fixture('mismatch.pdf'))).toBe('exe');
  });

  it('does not accept RIFF that is not WEBP', () => {
    const riffWav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WAVE'),
      Buffer.alloc(16),
    ]);

    expect(detectSignature(riffWav)).toBeUndefined();
    expect(verifySignature('webp', riffWav).verdict).toBe('mismatch');
  });

  it('treats decodable bytes as text, and binary as not', () => {
    expect(looksLikeText(Buffer.from('plain requirements text'))).toBe(true);
    expect(looksLikeText(Buffer.from([0x00, 0x01, 0x02]))).toBe(false);
  });

  it('spots an encrypted PDF from its trailer', () => {
    expect(looksEncryptedPdf(fixture('password-protected.pdf'))).toBe(true);
    expect(looksEncryptedPdf(fixture('requirements-digital.pdf'))).toBe(false);
  });
});

describe('ZIP container safety', () => {
  it('reads a real DOCX directory without decompressing it', () => {
    const result = inspectZipContainer(fixture('requirements.docx'), 209_715_200);

    expect(result.ok).toBe(true);
    expect(result.ok && result.entryCount).toBe(3);
  });

  it('refuses a container declaring more expansion than the limit', () => {
    const result = inspectZipContainer(fixture('features.xlsx'), 100);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('expansion_limit');
  });

  it('refuses bytes that are not a ZIP at all', () => {
    const result = inspectZipContainer(Buffer.from('not a zip'), 209_715_200);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('malformed');
  });

  it('detects an XML entity declaration', () => {
    expect(
      containsXmlEntityDeclaration('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'),
    ).toBe(true);
    expect(containsXmlEntityDeclaration('<w:document><w:body/></w:document>')).toBe(false);
  });
});

describe('FileValidator', () => {
  const validator = makeValidator();

  it('accepts a genuine PDF', () => {
    const outcome = validator.validate({
      originalFilename: 'requirements.pdf',
      declaredMimeType: 'application/pdf',
      content: fixture('requirements-digital.pdf'),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.file.extension).toBe('pdf');
    expect(outcome.ok && outcome.file.detectedMimeType).toBe('application/pdf');
    expect(outcome.ok && outcome.file.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses an executable wearing a .pdf name', () => {
    const outcome = validator.validate({
      originalFilename: 'invoice.pdf',
      declaredMimeType: 'application/pdf',
      content: fixture('mismatch.pdf'),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.rejection.code).toBe('SIGNATURE_MISMATCH');
  });

  it('refuses a declared type that contradicts the extension', () => {
    const outcome = validator.validate({
      originalFilename: 'requirements.pdf',
      declaredMimeType: 'image/png',
      content: fixture('requirements-digital.pdf'),
    });

    expect(outcome.ok === false && outcome.rejection.code).toBe('MIME_MISMATCH');
  });

  it('tolerates an unspecified type, because the bytes decide', () => {
    const outcome = validator.validate({
      originalFilename: 'features.csv',
      declaredMimeType: 'application/octet-stream',
      content: fixture('features.csv'),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.file.notes).toContain('mime_unspecified');
  });

  it('refuses an empty file', () => {
    const outcome = validator.validate({
      originalFilename: 'empty.txt',
      declaredMimeType: 'text/plain',
      content: Buffer.alloc(0),
    });

    expect(outcome.ok === false && outcome.rejection.code).toBe('FILE_EMPTY');
  });

  it('refuses a file over the size limit', () => {
    const small = makeValidator({ upload: { maxFileBytes: 100 } });

    const outcome = small.validate({
      originalFilename: 'requirements.pdf',
      declaredMimeType: 'application/pdf',
      content: fixture('requirements-digital.pdf'),
    });

    expect(outcome.ok === false && outcome.rejection.code).toBe('FILE_TOO_LARGE');
  });

  it('refuses an unsupported extension', () => {
    const outcome = validator.validate({
      originalFilename: 'archive.zip',
      declaredMimeType: 'application/zip',
      content: fixture('requirements.docx'),
    });

    expect(outcome.ok === false && outcome.rejection.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('refuses a traversal filename before anything else happens', () => {
    const outcome = validator.validate({
      originalFilename: '../../../etc/passwd.txt',
      declaredMimeType: 'text/plain',
      content: Buffer.from('root:x:0:0'),
    });

    expect(outcome.ok === false && outcome.rejection.code).toBe('UNSAFE_FILENAME');
  });

  it('refuses a password-protected PDF', () => {
    const outcome = validator.validate({
      originalFilename: 'secret.pdf',
      declaredMimeType: 'application/pdf',
      content: fixture('password-protected.pdf'),
    });

    expect(outcome.ok === false && outcome.rejection.code).toBe('PASSWORD_PROTECTED');
  });

  it('notes a double extension without refusing an ordinary one', () => {
    const outcome = validator.validate({
      originalFilename: 'requirements.v2.pdf',
      declaredMimeType: 'application/pdf',
      content: fixture('requirements-digital.pdf'),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.file.notes).toContain('multiple_extensions');
  });

  it('refuses .doc when no converter is configured, and says why', () => {
    const outcome = validator.validate({
      originalFilename: 'legacy.doc',
      declaredMimeType: 'application/msword',
      content: Buffer.from('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1padding', 'latin1'),
    });

    expect(outcome.ok === false && outcome.rejection.code).toBe('LEGACY_FORMAT_UNAVAILABLE');
  });

  it('accepts .doc once a converter is configured', () => {
    const withConverter = makeValidator({ legacyConversion: { enabled: true } });

    const outcome = withConverter.validate({
      originalFilename: 'legacy.doc',
      declaredMimeType: 'application/msword',
      content: Buffer.from('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1padding', 'latin1'),
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.file.requiresLegacyConversion).toBe(true);
  });

  it('produces a stable checksum for identical bytes', () => {
    const first = validator.validate({
      originalFilename: 'a.txt',
      declaredMimeType: 'text/plain',
      content: Buffer.from('same bytes'),
    });

    const second = validator.validate({
      originalFilename: 'differently-named.txt',
      declaredMimeType: 'text/plain',
      content: Buffer.from('same bytes'),
    });

    expect(first.ok && second.ok && first.file.checksumSha256).toBe(
      second.ok ? second.file.checksumSha256 : '',
    );
    expect(checksumOf('same bytes')).toBe(first.ok ? first.file.checksumSha256 : '');
  });
});
