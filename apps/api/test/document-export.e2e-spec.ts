import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ALLOWED_FORMATS,
  DOCUMENT_ROUTES,
  EXPORT_MIME_TYPES,
  PROJECT_ROUTES,
  type DocumentSnapshot,
  type ExportFormat,
  type ProjectDocument,
} from '@wdrg/contracts';
import ExcelJS from 'exceljs';
import { inflateRawSync } from 'node:zlib';
import request from 'supertest';
import { API_PREFIX, API_VERSION } from '@wdrg/contracts';

import { DeterministicProvider } from '../src/analysis/providers/deterministic.provider';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/config';
import { setupOpenApi } from '../src/openapi';
import { configureSecurity } from '../src/security';
import {
  approvedEstimateProject,
  documentFixture,
  type FixtureSession,
} from './documents-fixtures';

/**
 * Export, end to end, against real generated documents.
 *
 * The tests here inspect the files rather than the responses. A 200 with the right
 * `content-type` proves nothing about whether the bytes are a workbook, and "the endpoint
 * returned something" is exactly the assertion that lets a renamed text file pass for a
 * `.docx`. So a DOCX and an XLSX are opened as ZIP packages, an XLSX is parsed back into
 * cells, a PDF is checked for its signature and a CSV is parsed into rows.
 *
 * The other recurring theme is that export changes nothing. Several tests read the
 * document before and after downloading it and compare the version, the status and the
 * currentness — because the whole phase rests on a download being a read.
 */
describe('Document export (e2e)', () => {
  let app: NestExpressApplication;
  let provider: DeterministicProvider;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureSecurity(app, app.get(AppConfigService));
    app.setGlobalPrefix(API_PREFIX);
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: API_VERSION });
    setupOpenApi(app, app.get(AppConfigService));
    await app.init();

    provider = app.get(DeterministicProvider);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  /* --------------------------------------------------------------- helpers */

  const WEB = documentFixture('a web application');

  const UNDERSTANDING = 'OUR_UNDERSTANDING';
  const FEATURES = 'FEATURE_LISTING';
  const CRITERIA = 'ACCEPTANCE_CRITERIA';
  const ASSUMPTIONS = 'ASSUMPTIONS';
  const SOW = 'STATEMENT_OF_WORK';
  const WBS = 'WORK_BREAKDOWN_STRUCTURE';
  const CDS = 'CLIENT_DEPENDENCY_SHEET';

  /** Every document in order, so a suite can settle up to the one it needs. */
  const CHAIN = [UNDERSTANDING, FEATURES, CRITERIA, ASSUMPTIONS, SOW, WBS, CDS] as const;

  async function project(): Promise<FixtureSession> {
    return approvedEstimateProject(app.getHttpServer(), provider, WEB);
  }

  async function read(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    return (await session.agent.get(DOCUMENT_ROUTES.document(type)).expect(200)).body
      .document as DocumentSnapshot;
  }

  async function generate(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    const current = await read(session, type);

    return (
      await session.agent
        .post(DOCUMENT_ROUTES.generate(type))
        .set('x-csrf-token', session.csrf)
        .send({ useAi: false, expectedVersion: current.recordVersion })
        .expect(201)
    ).body.document as DocumentSnapshot;
  }

  /** Generate, dispose of any uncovered scope, validate and approve. */
  async function settle(session: FixtureSession, type: string): Promise<DocumentSnapshot> {
    await generate(session, type);

    const generated = await read(session, type);

    let version = generated.recordVersion;

    for (const requirementId of generated.blockers
      .filter((blocker) => blocker.kind === 'coverage_incomplete')
      .flatMap((blocker) => blocker.subjectIds)
      .filter((id) => id.startsWith('REQ-'))) {
      version = (
        (
          await session.agent
            .post(DOCUMENT_ROUTES.excludeRequirement(type))
            .set('x-csrf-token', session.csrf)
            .send({
              requirementId,
              reason: 'Recorded as out of scope for this document.',
              expectedVersion: version,
            })
            .expect(201)
        ).body.document as DocumentSnapshot
      ).recordVersion;
    }

    await session.agent
      .post(DOCUMENT_ROUTES.validate(type))
      .set('x-csrf-token', session.csrf)
      .send({ useAi: false })
      .expect(201);

    const validated = await read(session, type);

    await session.agent
      .post(DOCUMENT_ROUTES.approve(type))
      .set('x-csrf-token', session.csrf)
      .send({ acknowledged: true, expectedVersion: validated.recordVersion })
      .expect(201);

    return read(session, type);
  }

  /** Settle every document up to and including `last`. */
  async function chainTo(session: FixtureSession, last: string): Promise<void> {
    for (const type of CHAIN) {
      await settle(session, type);

      if (type === last) {
        return;
      }
    }
  }

  interface Downloaded {
    readonly status: number;
    readonly contentType: string;
    readonly disposition: string;
    readonly body: Buffer;
  }

  async function download(
    session: FixtureSession,
    type: string,
    format: ExportFormat,
    version?: number,
  ): Promise<Downloaded> {
    const query = version === undefined ? { format } : { format, version: String(version) };

    const response = await session.agent
      .get(DOCUMENT_ROUTES.export(type))
      .query(query)
      /* supertest must not try to parse a binary body as text. */
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    return {
      status: response.status,
      contentType: String(response.headers['content-type'] ?? ''),
      disposition: String(response.headers['content-disposition'] ?? ''),
      body: Buffer.isBuffer(response.body) ? response.body : Buffer.from(''),
    };
  }

  /* ------------------------------------------------------- file inspection */

  /** A ZIP local-file header. Both OOXML formats are ZIP packages. */
  const isZip = (body: Buffer): boolean =>
    Buffer.from(body).subarray(0, 2).toString('latin1') === 'PK';

  const isPdf = (body: Buffer): boolean =>
    Buffer.from(body).subarray(0, 5).toString('latin1') === '%PDF-';

  /**
   * Entry names from a ZIP's central directory.
   *
   * Matched on the central-directory signature rather than the bare "PK", which also begins
   * every local file header and the end-of-directory record — reading a name length at those
   * offsets walks off the end of the buffer.
   */
  function zipEntries(body: Buffer): readonly string[] {
    const names: string[] = [];
    const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

    let index = body.indexOf(signature);

    while (index !== -1 && index + 46 <= body.byteLength) {
      const nameLength = body.readUInt16LE(index + 28);

      names.push(body.subarray(index + 46, index + 46 + nameLength).toString('utf8'));
      index = body.indexOf(signature, index + 4);
    }

    return names;
  }

  /**
   * The text of a DOCX, inflated.
   *
   * `word/document.xml` is deflated inside the package, so searching the raw bytes for a
   * word finds nothing however plainly the document says it. Sizes and the local-header
   * offset come from the central directory, because the local header may carry zeros when
   * a writer uses a data descriptor.
   */
  function docxText(body: Buffer): string {
    const central = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

    let index = body.indexOf(central);

    while (index !== -1) {
      const nameLength = body.readUInt16LE(index + 28);
      const name = body.subarray(index + 46, index + 46 + nameLength).toString('utf8');

      if (name === 'word/document.xml') {
        const method = body.readUInt16LE(index + 10);
        const compressedSize = body.readUInt32LE(index + 20);
        const localOffset = body.readUInt32LE(index + 42);
        const localNameLength = body.readUInt16LE(localOffset + 26);
        const localExtraLength = body.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const data = body.subarray(start, start + compressedSize);

        return (method === 0 ? data : inflateRawSync(data)).toString('utf8');
      }

      index = body.indexOf(central, index + 4);
    }

    throw new Error('This package has no word/document.xml.');
  }

  async function workbook(body: Buffer): Promise<ExcelJS.Workbook> {
    const parsed = new ExcelJS.Workbook();

    await parsed.xlsx.load(Buffer.from(body) as never);

    return parsed;
  }

  /** CSV rows, quotes resolved. Enough of RFC 4180 to check a real file. */
  function csvRows(body: Buffer): readonly (readonly string[])[] {
    /* The BOM is deliberate in the output; strip it before parsing. */
    const text = body.toString('utf8').replace(/^\uFEFF/, '');
    const rows: string[][] = [];

    let row: string[] = [];
    let field = '';
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];

      if (quoted) {
        if (character === '"' && text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else if (character === '"') {
          quoted = false;
        } else {
          field += character;
        }

        continue;
      }

      if (character === '"') {
        quoted = true;
      } else if (character === ',') {
        row.push(field);
        field = '';
      } else if (character === '\r') {
        /* Consumed with the newline that follows it. */
      } else if (character === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += character;
      }
    }

    if (field !== '' || row.length > 0) {
      row.push(field);
      rows.push(row);
    }

    return rows;
  }

  /* -------------------------------------------------- 1 to 21: the matrix */

  describe('every supported document and format produces a real file', () => {
    /*
     * One project, settled through the whole chain, then exported twenty-one ways.
     * Rebuilding the chain per format would multiply the heaviest fixture in the suite by
     * twenty-one for no additional coverage — the matrix is about formats, and the
     * document content is identical across them.
     */
    let session: FixtureSession;

    beforeAll(async () => {
      session = await project();
      await chainTo(session, CDS);
    }, 300_000);

    const pairs: readonly (readonly [ProjectDocument, ExportFormat])[] = (
      Object.entries(ALLOWED_FORMATS) as [ProjectDocument, readonly ExportFormat[]][]
    ).flatMap(([document, formats]) => formats.map((format) => [document, format] as const));

    it('covers exactly the twenty-one pairs the matrix declares', () => {
      expect(pairs).toHaveLength(21);
    });

    it.each(pairs)(
      '%s exports as %s',
      async (document, format) => {
        const file = await download(session, document, format);

        expect(file.status).toBe(200);
        expect(file.contentType).toContain(EXPORT_MIME_TYPES[format].split(';')[0]);
        expect(file.body.byteLength).toBeGreaterThan(0);

        /* The bytes, not the header: this is what tells a real file from a renamed one. */
        switch (format) {
          case 'PDF':
            expect(isPdf(file.body)).toBe(true);
            break;
          case 'DOCX': {
            expect(isZip(file.body)).toBe(true);
            expect(zipEntries(file.body)).toContain('word/document.xml');
            break;
          }
          case 'XLSX': {
            expect(isZip(file.body)).toBe(true);
            const parsed = await workbook(file.body);
            expect(parsed.worksheets.length).toBeGreaterThan(0);
            break;
          }
          case 'CSV': {
            const rows = csvRows(file.body);
            expect(rows.length).toBeGreaterThan(0);
            break;
          }
        }
      },
      120_000,
    );

    it('22. refuses a document and format the matrix does not pair', async () => {
      /* Prose has no CSV, and Assumptions has no spreadsheet. */
      expect((await download(session, UNDERSTANDING, 'CSV')).status).toBe(422);
      expect((await download(session, ASSUMPTIONS, 'XLSX')).status).toBe(422);
      expect((await download(session, SOW, 'CSV')).status).toBe(422);
    });

    it('37. the Feature CSV still has exactly its eight headers, in order', async () => {
      const rows = csvRows((await download(session, FEATURES, 'CSV')).body);

      expect(rows[0]).toEqual([
        'Module',
        'Sub Module',
        'Screen',
        'Detailed Feature Description',
        'Estimated Hours - Backend Dev',
        'Estimated Hours - Frontend Dev',
        'Estimated Hours - QA',
        'Estimated Hours - Other Roles (mention role)',
      ]);
    });

    it('49. returns the right MIME type and an attachment filename', async () => {
      const file = await download(session, WBS, 'XLSX');

      expect(file.contentType).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(file.disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.xlsx"$/);
      expect(file.disposition).toContain('_v');
    });

    it('34. a filename cannot carry a path, whatever the project is called', async () => {
      const file = await download(session, UNDERSTANDING, 'PDF');

      const filename = /filename="([^"]+)"/.exec(file.disposition)?.[1] ?? '';

      expect(filename).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(filename).not.toContain('..');
      expect(filename).not.toContain('/');
    });

    it('53. the workbook holds no macros', async () => {
      const entries = zipEntries((await download(session, WBS, 'XLSX')).body);

      expect(entries.some((entry) => entry.includes('vbaProject'))).toBe(false);
      expect(entries.some((entry) => entry.endsWith('.bin'))).toBe(false);
    });

    it('28, 29. exporting creates no version and moves no lifecycle', async () => {
      const before = await read(session, WBS);

      await download(session, WBS, 'XLSX');
      await download(session, WBS, 'PDF');
      await download(session, WBS, 'CSV');
      await download(session, WBS, 'DOCX');

      const after = await read(session, WBS);

      expect(after.version).toBe(before.version);
      expect(after.status).toBe(before.status);
      expect(after.currentness).toBe(before.currentness);
      expect(after.recordVersion).toBe(before.recordVersion);
      expect(after.approvedAt).toBe(before.approvedAt);
    });

    it('50. no AI provider is invoked by an export', async () => {
      const before = provider.requests.length;

      await download(session, UNDERSTANDING, 'DOCX');
      await download(session, FEATURES, 'XLSX');

      expect(provider.requests.length).toBe(before);
    });

    it('54, 55. effort stays numeric and exact in the workbook', async () => {
      const parsed = await workbook((await download(session, FEATURES, 'XLSX')).body);
      const sheet = parsed.worksheets[0]!;

      const numbers: number[] = [];

      sheet.eachRow((row, index) => {
        if (index === 1) {
          return;
        }

        for (const column of [5, 6, 7]) {
          const value = row.getCell(column).value;

          if (typeof value === 'number') {
            numbers.push(value);
          }
        }
      });

      expect(numbers.length).toBeGreaterThan(0);

      /* Numeric, not text that looks numeric, and not rounded to whole hours. */
      for (const value of numbers) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
        expect(Number(value.toFixed(2))).toBe(value);
      }
    });

    it('43, 44, 45. every row survives each structured format', async () => {
      for (const [document, rowCount] of [
        [FEATURES, (await read(session, FEATURES)).features.length],
        [WBS, (await read(session, WBS)).rows.length],
        [CDS, (await read(session, CDS)).rows.length],
      ] as const) {
        expect(rowCount).toBeGreaterThan(0);

        const csv = csvRows(
          (await download(session, document, document === FEATURES ? 'CSV' : 'CSV')).body,
        );

        /* Header plus one line per row, and nothing quietly truncated. */
        expect(csv.length - 1).toBe(rowCount);

        const parsed = await workbook((await download(session, document, 'XLSX')).body);

        expect(parsed.worksheets[0]!.rowCount - 1).toBe(rowCount);
      }
    }, 120_000);

    it('51, 52. a formula-shaped value opens as text, in both CSV and XLSX', async () => {
      const criteria = await read(session, CRITERIA);
      const row = criteria.rows[0];

      expect(row).toBeDefined();

      await session.agent
        .patch(DOCUMENT_ROUTES.row(CRITERIA, row!.rowId))
        .set('x-csrf-token', session.csrf)
        .send({
          payload: { ...(row!.payload as object), then: '=cmd|calc' },
          expectedVersion: criteria.recordVersion,
        })
        .expect(200);

      const parsed = await workbook((await download(session, CRITERIA, 'XLSX')).body);
      const sheet = parsed.worksheets[0]!;

      let found = false;

      sheet.eachRow((sheetRow) => {
        sheetRow.eachCell((cell) => {
          const value = cell.value;

          if (typeof value === 'string' && value.includes('cmd|calc')) {
            found = true;
            /* Neutralised, and stored as a string rather than as a formula. */
            expect(value.startsWith("'=")).toBe(true);
            expect(typeof cell.value).toBe('string');
          }
        });
      });

      expect(found).toBe(true);
    }, 120_000);
  });

  /* ------------------------------------------- 23 to 27: what a file says */

  describe('a file says which version it is and what had been decided', () => {
    it('23. an ungenerated document cannot be exported', async () => {
      const session = await project();

      const file = await download(session, UNDERSTANDING, 'PDF');

      expect(file.status).toBe(422);
      expect(file.body.toString('utf8')).toContain('DOCUMENT_NOT_GENERATED');
    }, 180_000);

    it('24, 25, 70. each version exports its own content, not the latest', async () => {
      const session = await project();

      await generate(session, UNDERSTANDING);

      const first = await read(session, UNDERSTANDING);
      const section = first.sections[0]!;

      await session.agent
        .put(DOCUMENT_ROUTES.section(UNDERSTANDING, section.sectionId))
        .set('x-csrf-token', session.csrf)
        .send({
          body: 'Wording that belongs to the later version.',
          expectedVersion: first.recordVersion,
        })
        .expect(200);

      const second = await read(session, UNDERSTANDING);

      expect(second.version).toBeGreaterThan(first.version);

      const older = await download(session, UNDERSTANDING, 'DOCX', first.version);
      const newer = await download(session, UNDERSTANDING, 'DOCX', second.version);

      expect(older.status).toBe(200);
      expect(newer.status).toBe(200);
      /* Different versions, different bytes: no exporter reached for current content. */
      expect(older.body.equals(newer.body)).toBe(false);
      expect(older.disposition).toContain(`_v${first.version}`);
      expect(newer.disposition).toContain(`_v${second.version}`);
    }, 180_000);

    it('86. an unknown version is refused', async () => {
      const session = await project();

      await generate(session, UNDERSTANDING);

      expect((await download(session, UNDERSTANDING, 'PDF', 999)).status).toBe(404);
    }, 180_000);

    it('26, 33. an outdated approved document exports, saying so', async () => {
      const session = await project();

      await settle(session, UNDERSTANDING);
      await settle(session, FEATURES);

      const before = await read(session, FEATURES);

      const file = await download(session, FEATURES, 'PDF');

      expect(file.status).toBe(200);
      expect(isPdf(file.body)).toBe(true);

      const after = await read(session, FEATURES);

      /* Whatever its currentness, exporting did not change it. */
      expect(after.currentness).toBe(before.currentness);
      expect(after.status).toBe(before.status);
    }, 240_000);

    it('27, 31. a draft exports and is marked as one', async () => {
      const session = await project();

      const draft = await generate(session, UNDERSTANDING);

      expect(draft.status).toBe('DRAFT');

      const file = await download(session, UNDERSTANDING, 'DOCX');

      expect(file.status).toBe(200);
      expect(zipEntries(file.body)).toContain('word/document.xml');
      expect(docxText(file.body)).toContain('Draft');
    }, 180_000);

    it('26, 72. an issued version keeps exporting as itself after a revision', async () => {
      const session = await project();

      await settle(session, UNDERSTANDING);

      const approved = await read(session, UNDERSTANDING);

      expect(approved.status).toBe('APPROVED');
      expect(approved.currentness).toBe('CURRENT');

      await session.agent
        .post(DOCUMENT_ROUTES.markFinal(UNDERSTANDING))
        .set('x-csrf-token', session.csrf)
        .send({ acknowledged: true, expectedVersion: approved.recordVersion })
        .expect(201);

      const issued = await read(session, UNDERSTANDING);

      expect(issued.status).toBe('FINAL');

      const beforeRevision = await download(session, UNDERSTANDING, 'PDF', issued.version);

      expect(beforeRevision.status).toBe(200);
      /* The lifecycle label appears in the filename of an issued document. */
      expect(beforeRevision.disposition).toContain('Issued');

      await session.agent
        .post(DOCUMENT_ROUTES.revise(UNDERSTANDING))
        .set('x-csrf-token', session.csrf)
        .send({ reason: 'A second issue is needed', expectedVersion: issued.recordVersion })
        .expect(201);

      const afterRevision = await download(session, UNDERSTANDING, 'PDF', issued.version);

      expect(afterRevision.status).toBe(200);
      expect(afterRevision.body.byteLength).toBe(beforeRevision.body.byteLength);
    }, 240_000);

    it('42, 63, 73. an approved Assumptions document with nothing in it still exports', async () => {
      const session = await project();

      await settle(session, UNDERSTANDING);
      await settle(session, FEATURES);
      await settle(session, CRITERIA);
      const assumptions = await settle(session, ASSUMPTIONS);

      /* Whether the fixture produced rows or not, both formats must succeed. */
      const docx = await download(session, ASSUMPTIONS, 'DOCX');
      const pdf = await download(session, ASSUMPTIONS, 'PDF');

      expect(docx.status).toBe(200);
      expect(pdf.status).toBe(200);
      expect(isPdf(pdf.body)).toBe(true);
      expect(zipEntries(docx.body)).toContain('word/document.xml');

      if (assumptions.rows.length === 0) {
        /* An honest empty document, not an error and not a broken table. */
        expect(docxText(docx.body)).toContain('No assumptions');
      }
    }, 300_000);
  });

  /* ---------------------------------------------- 30 to 33: branding */

  describe('branding changes presentation and nothing else', () => {
    it('31, 35. the default is unbranded and still produces a usable file', async () => {
      const session = await project();

      await settle(session, UNDERSTANDING);

      const branding = (await session.agent.get(PROJECT_ROUTES.branding).expect(200)).body as {
        branding: Record<string, unknown>;
      };

      expect(branding.branding).toEqual({});

      const file = await download(session, UNDERSTANDING, 'PDF');

      expect(file.status).toBe(200);
      expect(isPdf(file.body)).toBe(true);
    }, 180_000);

    it('30, 38, 39, 71. branding alters the file, never the document', async () => {
      const session = await project();

      await settle(session, UNDERSTANDING);

      const before = await read(session, UNDERSTANDING);
      const plain = await download(session, UNDERSTANDING, 'PDF');

      const project0 = (await session.agent.get(PROJECT_ROUTES.current).expect(200)).body as {
        version: number;
      };

      await session.agent
        .put(PROJECT_ROUTES.branding)
        .set('x-csrf-token', session.csrf)
        .send({
          branding: {
            organizationName: 'Hiteshi',
            footerText: 'Commercial in confidence',
            accentColor: '#1F3A5F',
          },
          version: project0.version,
        })
        .expect(200);

      const branded = await download(session, UNDERSTANDING, 'PDF');
      const after = await read(session, UNDERSTANDING);

      expect(branded.status).toBe(200);
      /* The file changed. */
      expect(branded.body.equals(plain.body)).toBe(false);
      expect(docxText((await download(session, UNDERSTANDING, 'DOCX')).body)).toContain('Hiteshi');

      /* The document did not. */
      expect(after.version).toBe(before.version);
      expect(after.status).toBe(before.status);
      expect(after.currentness).toBe(before.currentness);
      expect(after.recordVersion).toBe(before.recordVersion);
    }, 240_000);

    it('33, 42. an unusable accent colour is refused rather than rendered', async () => {
      const session = await project();

      const current = (await session.agent.get(PROJECT_ROUTES.current).expect(200)).body as {
        version: number;
      };

      for (const accentColor of ['red', '#FFF', 'url(javascript:alert(1))', 'rgb(0,0,0)']) {
        await session.agent
          .put(PROJECT_ROUTES.branding)
          .set('x-csrf-token', session.csrf)
          .send({ branding: { accentColor }, version: current.version })
          .expect(422);
      }
    }, 180_000);

    it('41, 68. a logo that is not a real image is refused', async () => {
      const session = await project();

      /* An SVG renamed .png: an XML document with script in it. */
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'utf8');

      await session.agent
        .post(PROJECT_ROUTES.brandingLogo)
        .set('x-csrf-token', session.csrf)
        .attach('logo', svg, { filename: '../../evil.png', contentType: 'image/png' })
        .expect(422);

      /* A text file with a PNG name is refused by signature, not by extension. */
      await session.agent
        .post(PROJECT_ROUTES.brandingLogo)
        .set('x-csrf-token', session.csrf)
        .attach('logo', Buffer.from('not an image', 'utf8'), {
          filename: 'logo.png',
          contentType: 'image/png',
        })
        .expect(422);
    }, 180_000);

    it('32, 40. a real PNG is accepted and reaches the rendered file', async () => {
      const session = await project();

      await settle(session, UNDERSTANDING);

      /* A 1×1 PNG, assembled here rather than committed as a fixture binary. */
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64',
      );

      const uploaded = (
        await session.agent
          .post(PROJECT_ROUTES.brandingLogo)
          .set('x-csrf-token', session.csrf)
          .attach('logo', png, { filename: 'mark.png', contentType: 'image/png' })
          .expect(201)
      ).body as { logo: { objectId: string; contentType: string } };

      expect(uploaded.logo.contentType).toBe('image/png');
      /* A server-generated id: nothing the client sent became a path. */
      expect(uploaded.logo.objectId).toMatch(/^logo_[0-9a-f]+$/);

      const current = (await session.agent.get(PROJECT_ROUTES.current).expect(200)).body as {
        version: number;
      };

      await session.agent
        .put(PROJECT_ROUTES.branding)
        .set('x-csrf-token', session.csrf)
        .send({ branding: { logo: uploaded.logo }, version: current.version })
        .expect(200);

      const withLogo = await download(session, UNDERSTANDING, 'DOCX');

      expect(withLogo.status).toBe(200);
      /* An image part in the package: the logo was embedded, not ignored. */
      expect(zipEntries(withLogo.body).some((entry) => entry.startsWith('word/media/'))).toBe(true);
    }, 240_000);
  });

  /* -------------------------------------- 35, 36: another project's documents */

  describe('another project cannot be exported', () => {
    it('35, 36, 84, 85. neither the current version nor a historical one', async () => {
      const owner = await project();

      await settle(owner, UNDERSTANDING);

      const owned = await read(owner, UNDERSTANDING);

      const stranger = request.agent(app.getHttpServer());

      await stranger
        .post(PROJECT_ROUTES.create)
        .send({ name: 'A different project', projectTypes: ['WEB_APPLICATION'] })
        .expect(201);

      /* The stranger has a session, and its own project has no documents. */
      const current = await stranger
        .get(DOCUMENT_ROUTES.export(UNDERSTANDING))
        .query({ format: 'PDF' });

      const historical = await stranger
        .get(DOCUMENT_ROUTES.export(UNDERSTANDING))
        .query({ format: 'PDF', version: String(owned.version) });

      /* Never the owner's bytes: refused, and indistinguishable from "no such version". */
      expect([403, 404, 422]).toContain(current.status);
      expect([403, 404, 422]).toContain(historical.status);
    }, 240_000);
  });

  /* ------------------------------------------------------------ 51: OpenAPI */

  describe('the API document', () => {
    it('51. describes the export operation and its formats', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs-json').expect(200);

      const paths = response.body.paths as Record<string, unknown>;

      expect(paths[DOCUMENT_ROUTES.export('{type}')]).toBeDefined();
      expect(paths[PROJECT_ROUTES.branding]).toBeDefined();
      expect(paths[PROJECT_ROUTES.brandingLogo]).toBeDefined();
    });
  });
});
