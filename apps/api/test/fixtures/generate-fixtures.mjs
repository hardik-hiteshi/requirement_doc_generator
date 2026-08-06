#!/usr/bin/env node
/**
 * Builds the binary Phase 3 test fixtures.
 *
 * Every file is constructed here rather than downloaded or copied from a real
 * document. That buys three things a checked-in sample cannot:
 *
 *  - **No network during tests.** A suite that fetches a sample PDF fails when
 *    the network does, and passes for reasons unrelated to the code.
 *  - **No copyright question.** Nothing here is anyone else's document.
 *  - **Reproducibility.** The bytes are a function of this script, so a fixture
 *    that starts behaving differently can be regenerated and diffed.
 *
 * The outputs are committed. This exists so they can be rebuilt and inspected,
 * not so tests can generate them on the fly.
 *
 * Run from apps/api:  node test/fixtures/generate-fixtures.mjs
 */
import { createCanvas } from '@napi-rs/canvas';
import ExcelJS from 'exceljs';
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const out = (name) => join(here, name);

/* ------------------------------------------------------------------- DOCX */

/**
 * A minimal WordprocessingML document, written as a ZIP by hand.
 *
 * Stored (uncompressed) entries with a fixed timestamp, so the bytes are
 * identical on every run — a fixture whose checksum drifts would break the
 * duplicate-detection tests for reasons that have nothing to do with them.
 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags — bit 0 clear means not encrypted
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBytes, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, directory, eocd]);
}

function crc32(buffer) {
  let crc = -1;

  for (const byte of buffer) {
    crc ^= byte;

    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }

  return (crc ^ -1) >>> 0;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const paragraph = (text, style) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${paragraph('Northwind Quoting Platform', 'Heading1')}
${paragraph('The system must let a sales user build a quote from a product catalogue.')}
${paragraph('Scope', 'Heading2')}
${paragraph('Quotes must be approved by a manager before they are sent to a client.')}
${paragraph('Approved quotes must be exported as PDF.')}
<w:tbl>
<w:tr><w:tc>${paragraph('Module')}</w:tc><w:tc>${paragraph('Priority')}</w:tc></w:tr>
<w:tr><w:tc>${paragraph('Catalogue')}</w:tc><w:tc>${paragraph('High')}</w:tc></w:tr>
<w:tr><w:tc>${paragraph('Quoting')}</w:tc><w:tc>${paragraph('High')}</w:tc></w:tr>
</w:tbl>
</w:body></w:document>`;

writeFileSync(
  out('requirements.docx'),
  buildZip([
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['word/document.xml', DOCUMENT_XML],
  ]),
);

/* ------------------------------------------------------------------- XLSX */

const workbook = new ExcelJS.Workbook();
// Fixed metadata: exceljs writes created/modified timestamps into the file, and
// a fixture whose bytes change every run cannot be a duplicate-detection test.
workbook.created = new Date(0);
workbook.modified = new Date(0);

const features = workbook.addWorksheet('Features');
features.addRow(['Module', 'Feature', 'Priority', 'Estimate']);
features.addRow(['Catalogue', 'Browse products', 'High', 8]);
features.addRow(['Catalogue', 'Search by SKU', 'Medium', 5]);
features.addRow(['Quoting', 'Build a quote', 'High', 13]);
features.getCell('D5').value = { formula: 'SUM(D2:D4)', result: 26 };
features.getCell('A5').value = 'Total';

const assumptions = workbook.addWorksheet('Assumptions');
assumptions.addRow(['Assumption']);
assumptions.addRow(['The client provides the product catalogue as a CSV export.']);

const notes = workbook.addWorksheet('Internal notes');
notes.state = 'hidden';
notes.addRow(['This sheet is hidden and must not be extracted.']);

await workbook.xlsx.writeFile(out('features.xlsx'));

/* ------------------------------------------------------- images with text */

function renderText(lines, { width = 640, height = 220, font = '28px sans-serif' } = {}) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#000000';
  context.font = font;

  lines.forEach((line, index) => {
    context.fillText(line, 24, 56 + index * 44);
  });

  return canvas;
}

const printed = renderText([
  'Northwind Quoting Platform',
  'Quotes need manager approval',
  'Export approved quotes as PDF',
]);

writeFileSync(out('printed-requirements.png'), printed.toBuffer('image/png'));
writeFileSync(out('printed-requirements.jpg'), printed.toBuffer('image/jpeg'));

/* --------------------------------------------------------- PDF (digital) */

/**
 * A minimal PDF with a real text layer.
 *
 * Hand-written because every PDF library either adds a dependency for a file
 * this small or produces output containing a generation timestamp, which would
 * make the fixture's checksum move.
 */
function buildDigitalPdf() {
  const lines = [
    'Northwind Quoting Platform',
    'The system must let a sales user build a quote.',
    'Quotes need manager approval before they are sent.',
  ];

  const stream = [
    'BT',
    '/F1 16 Tf',
    '72 720 Td',
    ...lines.flatMap((line, index) => [
      index === 0 ? '' : '0 -28 Td',
      `(${line.replace(/[()\\]/g, '\\$&')}) Tj`,
    ]),
    'ET',
  ]
    .filter(Boolean)
    .join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  return assemblePdf(objects);
}

function assemblePdf(objects, trailerExtra = '') {
  let pdf = '%PDF-1.7\n';
  const offsets = [];

  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${trailerExtra} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

writeFileSync(out('requirements-digital.pdf'), buildDigitalPdf());

/* --------------------------------------------------------- PDF (scanned) */

/**
 * A PDF whose only content is an image: no text layer at all.
 *
 * This is what the pipeline must detect and route to OCR. The image is the same
 * rendered text used for the PNG fixture, embedded as a Flate-compressed RGB
 * XObject.
 */
function buildScannedPdf() {
  const canvas = renderText(['Scanned requirement page', 'Approval is required before export'], {
    width: 900,
    height: 300,
    font: 'bold 34px sans-serif',
  });

  const { width, height } = canvas;
  const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data;

  // RGB, dropping alpha: /DeviceRGB expects three samples per pixel.
  const rgb = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgb[pixel * 3] = rgba[pixel * 4];
    rgb[pixel * 3 + 1] = rgba[pixel * 4 + 1];
    rgb[pixel * 3 + 2] = rgba[pixel * 4 + 2];
  }

  const compressed = deflateSync(rgb);
  const contentStream = `q\n${width} 0 0 ${height} 0 ${792 - height} cm\n/Im1 Do\nQ`;

  const header =
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
    `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>`;

  // Built as bytes rather than a string: the compressed image is binary and
  // would be corrupted by a latin1 round-trip through the text assembler.
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
        '/Resources << /XObject << /Im1 5 0 R >> >> >>',
      'latin1',
    ),
    Buffer.from(
      `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
      'latin1',
    ),
    Buffer.concat([
      Buffer.from(`${header}\nstream\n`, 'latin1'),
      compressed,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  ];

  let pdf = Buffer.from('%PDF-1.7\n', 'latin1');
  const offsets = [];

  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf = Buffer.concat([
      pdf,
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
  });

  const xrefOffset = pdf.length;
  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    tail += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  tail += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.concat([pdf, Buffer.from(tail, 'latin1')]);
}

writeFileSync(out('requirements-scanned.pdf'), buildScannedPdf());

/* ------------------------------------------------ PDF (password-protected) */

/**
 * A PDF declaring `/Encrypt` in its trailer.
 *
 * The validator refuses on that declaration alone, before any parser opens the
 * file — so the fixture does not need real RC4-encrypted streams to exercise the
 * path that matters. What is being tested is that an encrypted document is
 * refused with a clear message, not that we can decrypt one.
 */
writeFileSync(
  out('password-protected.pdf'),
  assemblePdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
      '<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -1 >>',
    ],
    ' /Encrypt 4 0 R',
  ),
);

console.log('binary fixtures written');
