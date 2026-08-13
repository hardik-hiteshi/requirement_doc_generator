import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';

import type { ExportMetadata } from '@wdrg/contracts';

import type { Block, ProseProjection } from '../export-projection';

/**
 * A real Office Open XML document, written locally by `docx`.
 *
 * No conversion service, no headless browser, no external executable: the package writes
 * the OOXML package itself, which keeps rendering offline, keeps CI light and leaves no
 * process to invoke with user strings.
 *
 * The layout is deliberately plain. A client document wants a title, headings that mean
 * something, readable tables and a footer — not a designed brochure. Branding tints the
 * headings and puts the organisation's name and notice where they belong; body text stays
 * black on white so it is readable whatever accent somebody picked.
 */

const ACCENT_FALLBACK = '1F2933';

const hex = (accentColor: string): string =>
  accentColor.replace('#', '').toUpperCase() || ACCENT_FALLBACK;

function heading(text: string, level: 1 | 2 | 3, accent: string): Paragraph {
  return new Paragraph({
    heading:
      level === 1
        ? HeadingLevel.TITLE
        : level === 2
          ? HeadingLevel.HEADING_1
          : HeadingLevel.HEADING_2,
    spacing: { before: level === 1 ? 0 : 240, after: 120 },
    children: [new TextRun({ text, color: accent, bold: true })],
  });
}

function table(block: Extract<Block, { kind: 'table' }>, accent: string): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: block.columns.map(
      (column) =>
        new TableCell({
          shading: { fill: accent },
          children: [
            new Paragraph({
              children: [new TextRun({ text: column, bold: true, color: 'FFFFFF' })],
            }),
          ],
        }),
    ),
  });

  const bodyRows = block.rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (value) =>
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: value })] })],
            }),
        ),
      }),
  );

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE4' },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE4' },
      left: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE4' },
      right: { style: BorderStyle.SINGLE, size: 1, color: 'D8DEE4' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'E8EDF2' },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'E8EDF2' },
    },
    rows: [headerRow, ...bodyRows],
  });
}

export async function renderDocx(input: {
  readonly projection: ProseProjection;
  readonly metadata: ExportMetadata;
  readonly accentColor: string;
  readonly logo?: { readonly content: Buffer; readonly contentType: 'image/png' | 'image/jpeg' };
}): Promise<Buffer> {
  const accent = hex(input.accentColor);
  const children: (Paragraph | Table)[] = [];

  if (input.logo) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new ImageRun({
            data: input.logo.content,
            transformation: { width: 120, height: 48 },
            type: input.logo.contentType === 'image/png' ? 'png' : 'jpg',
          }),
        ],
      }),
    );
  }

  if (input.metadata.organizationName) {
    children.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({ text: input.metadata.organizationName, bold: true, color: accent }),
        ],
      }),
    );
  }

  for (const block of input.projection.blocks) {
    switch (block.kind) {
      case 'heading':
        children.push(heading(block.text, block.level, accent));
        break;
      case 'paragraph':
        children.push(
          new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: block.text })] }),
        );
        break;
      case 'bullets':
        for (const item of block.items) {
          children.push(
            new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: item })] }),
          );
        }
        break;
      case 'note':
        children.push(
          new Paragraph({
            spacing: { after: 120 },
            children: [new TextRun({ text: block.text, italics: true, color: '52606D' })],
          }),
        );
        break;
      case 'table':
        if (block.caption) {
          children.push(heading(block.caption, 3, accent));
        }

        children.push(table(block, accent));
        children.push(new Paragraph({ text: '' }));
        break;
    }
  }

  const footerText = [
    input.metadata.footerText,
    `${input.metadata.documentLabel} v${input.metadata.documentVersion}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ');

  const document = new Document({
    creator: input.metadata.organizationName ?? 'Requirement Documentation Generator',
    title: `${input.metadata.projectName} — ${input.metadata.documentLabel}`,
    description: `Version ${input.metadata.documentVersion}, ${input.metadata.statusLabel}`,
    sections: [
      {
        properties: {
          page: {
            size: {
              orientation: input.projection.landscape
                ? PageOrientation.LANDSCAPE
                : PageOrientation.PORTRAIT,
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: footerText, size: 16, color: '7B8794' })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(document);
}
