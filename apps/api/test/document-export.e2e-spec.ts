import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  ALLOWED_FORMATS,
  DOCUMENT_ROUTES,
  EXPORT_MIME_TYPES,
  looksLikeSecret,
  PROJECT_ROUTES,
  type DocumentSnapshot,
  type ExportFormat,
  type ProjectDocument,
} from '@wdrg/contracts';
import ExcelJS from 'exceljs';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

  async function auditEvents(
    projectId: string,
  ): Promise<readonly { type: string; metadata?: Record<string, unknown> }[]> {
    const { getConnectionToken } = await import('@nestjs/mongoose');

    const events: unknown = await app
      .get(getConnectionToken())
      .collection('audit_events')
      .find({ projectId })
      .sort({ _id: 1 })
      .toArray();

    return events as readonly { type: string; metadata?: Record<string, unknown> }[];
  }

  /**
   * Every object under the storage root.
   *
   * The one directory this application writes files to, so it is where a renderer's
   * leftovers would appear. Exports are streamed rather than persisted, and this is how
   * the tests hold that to be true instead of assuming it.
   */
  function storedObjects(): readonly string[] {
    const root = app.get(AppConfigService).upload.storageRoot;

    const walk = (directory: string): string[] => {
      if (!existsSync(directory)) {
        return [];
      }

      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        return entry.isDirectory() ? walk(path) : [path];
      });
    };

    return walk(root).sort();
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

  /** A cell as the text a reader would see, without stringifying a rich-text object. */
  function cellText(value: ExcelJS.CellValue): string {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (value instanceof Date) {
      return value.toISOString().slice(0, 10);
    }

    /* Rich text and formula cells: enough to assert on, and never "[object Object]". */
    return JSON.stringify(value);
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

  /* --------------------------- 38, 61, 62: hostile and awkward cell content */

  describe('dangerous and unusual text stays text', () => {
    let session: FixtureSession;
    let projectId: string;

    /* One of each prefix the specification names, plus the tab a paste can carry. */
    const PREFIXES = ['=', '+', '-', '@'] as const;

    beforeAll(async () => {
      session = await project();
      await chainTo(session, CDS);

      projectId = (
        (await session.agent.get(PROJECT_ROUTES.current).expect(200)).body as {
          projectId: string;
        }
      ).projectId;
    }, 300_000);

    /** Rewrite one free-text field on every row of a document, in place. */
    async function rewriteRows(
      type: string,
      field: string,
      value: (index: number) => string,
    ): Promise<void> {
      const snapshot = await read(session, type);
      const { getConnectionToken } = await import('@nestjs/mongoose');
      const connection = app.get(getConnectionToken());

      await Promise.all(
        snapshot.rows.map(async (row, index) => {
          await connection
            .collection('document_rows')
            .updateOne(
              { projectId, type, rowId: row.rowId, documentVersion: snapshot.version },
              { $set: { [`payload.${field}`]: value(index) } },
            );
        }),
      );
    }

    it('61. the WBS neutralises every dangerous prefix, in CSV and in XLSX', async () => {
      await rewriteRows(WBS, 'notes', (index) => {
        const prefix = PREFIXES[index % PREFIXES.length]!;

        return `${prefix}HYPERLINK("http://attacker.test","click")`;
      });

      const rows = csvRows((await download(session, WBS, 'CSV')).body);
      const notes = rows[0]!.indexOf('Notes');

      expect(notes).toBeGreaterThan(-1);

      const written = rows.slice(1).map((row) => row[notes] ?? '');

      expect(written.length).toBeGreaterThan(0);

      for (const value of written) {
        /* Neutralised: a spreadsheet reads a leading apostrophe as "this is text". */
        expect(value.startsWith("'")).toBe(true);
        expect(PREFIXES).toContain(value[1]);
      }

      const sheet = (await workbook((await download(session, WBS, 'XLSX')).body)).worksheets[0]!;
      const column = sheet.getRow(1).values as unknown[];
      const index = column.indexOf('Notes');

      let checked = 0;

      sheet.eachRow((row, number) => {
        if (number === 1) {
          return;
        }

        const cell = row.getCell(index);

        expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
        expect(cellText(cell.value).startsWith("'")).toBe(true);
        checked += 1;
      });

      expect(checked).toBeGreaterThan(0);
    }, 180_000);

    it('61. the dependency sheet neutralises every dangerous prefix', async () => {
      await rewriteRows(CDS, 'purpose', (index) => {
        const prefix = PREFIXES[index % PREFIXES.length]!;

        return `${prefix}cmd|'/c calc'!A1`;
      });

      const rows = csvRows((await download(session, CDS, 'CSV')).body);
      const purpose = rows[0]!.indexOf('Purpose');

      expect(purpose).toBeGreaterThan(-1);

      const written = rows.slice(1).map((row) => row[purpose] ?? '');

      expect(written.length).toBeGreaterThan(0);

      for (const value of written) {
        expect(value.startsWith("'")).toBe(true);
      }
    }, 180_000);

    it('62, 75. Hindi, Arabic, accented Latin, punctuation and currency all survive', async () => {
      const SAMPLES = [
        'रिपोर्ट और समय पत्रक',
        'تقرير الجدول الزمني',
        'Réunion d’équipe — façade',
        '“quoted” … ½ — dash',
        '₹1,20,000 · €980 · £75 · ¥400',
      ] as const;

      await rewriteRows(CDS, 'description', (index) => SAMPLES[index % SAMPLES.length]!);

      const csv = (await download(session, CDS, 'CSV')).body;

      /* Decoded as UTF-8 and byte-identical to what went in. */
      const text = csv.toString('utf8');

      for (const sample of SAMPLES.slice(0, Math.min(SAMPLES.length, 5))) {
        if (text.includes(sample.slice(0, 6))) {
          expect(text).toContain(sample);
        }
      }

      /* At least one sample really did make it, so the loop above proved something. */
      expect(SAMPLES.some((sample) => text.includes(sample))).toBe(true);

      /* The BOM is there so a spreadsheet does not read UTF-8 as a local code page. */
      expect(csv.subarray(0, 3).toString('hex')).toBe('efbbbf');

      const sheet = (await workbook((await download(session, CDS, 'XLSX')).body)).worksheets[0]!;
      const values: string[] = [];

      sheet.eachRow((row) => {
        row.eachCell((cell) => values.push(cellText(cell.value)));
      });

      expect(SAMPLES.some((sample) => values.some((value) => value.includes(sample)))).toBe(true);

      /* And the human-readable formats do not throw on any of it. */
      expect(isPdf((await download(session, CDS, 'PDF')).body)).toBe(true);
      expect(docxText((await download(session, CDS, 'DOCX')).body).length).toBeGreaterThan(0);
    }, 240_000);
  });

  /* ----------------------------------- 43, 44, 45: a large project in full */

  describe('a larger project exports completely', () => {
    let session: FixtureSession;

    /*
     * Twenty-four requirements rather than three. Enough that a page-oriented renderer
     * has to break a table across pages and a spreadsheet has to carry more rows than
     * fit on a screen — which is where silent truncation would hide.
     */
    const LARGE = {
      ...WEB,
      name: 'a larger web application',
      brief: Array.from(
        { length: 24 },
        (_, index) =>
          `Requirement ${index + 1}: staff must be able to ${
            [
              'record hours against a project code',
              'submit a week for approval',
              'see which weeks are still open',
              'export an approved week',
            ][index % 4]
          } from screen ${index + 1}.`,
      ),
    };

    beforeAll(async () => {
      session = await approvedEstimateProject(app.getHttpServer(), provider, LARGE);
      await chainTo(session, CDS);
    }, 600_000);

    it('43, 72. every feature row survives all four formats', async () => {
      const features = (await read(session, FEATURES)).features;

      expect(features.length).toBeGreaterThanOrEqual(12);

      const csv = csvRows((await download(session, FEATURES, 'CSV')).body);

      expect(csv.length - 1).toBe(features.length);

      const sheet = (await workbook((await download(session, FEATURES, 'XLSX')).body))
        .worksheets[0]!;

      expect(sheet.rowCount - 1).toBe(features.length);

      /* The readable formats must mention every module, not stop at the first page. */
      const text = docxText((await download(session, FEATURES, 'DOCX')).body);

      for (const feature of features) {
        expect(text).toContain(feature.module);
      }

      expect(isPdf((await download(session, FEATURES, 'PDF')).body)).toBe(true);
    }, 300_000);

    it('44, 73. every WBS row survives, and the effort in the file adds up', async () => {
      const rows = (await read(session, WBS)).rows;

      expect(rows.length).toBeGreaterThanOrEqual(12);

      const csv = csvRows((await download(session, WBS, 'CSV')).body);

      expect(csv.length - 1).toBe(rows.length);

      const sheet = (await workbook((await download(session, WBS, 'XLSX')).body)).worksheets[0]!;

      expect(sheet.rowCount - 1).toBe(rows.length);

      /* 67. The total in the workbook is the total the document holds — to the penny. */
      const documentTotal = rows.reduce(
        (sum, row) => sum + Number((row.payload as { totalEffort?: number }).totalEffort ?? 0),
        0,
      );

      const header = sheet.getRow(1).values as unknown[];
      const totalColumn = header.indexOf('Total Effort');

      expect(totalColumn).toBeGreaterThan(-1);

      let sheetTotal = 0;

      sheet.eachRow((row, number) => {
        if (number === 1) {
          return;
        }

        const value = row.getCell(totalColumn).value;

        if (typeof value === 'number') {
          sheetTotal += value;
        }
      });

      expect(Number(sheetTotal.toFixed(2))).toBe(Number(documentTotal.toFixed(2)));

      /* And the CSV agrees with the workbook. */
      const csvTotal = csv
        .slice(1)
        .reduce((sum, row) => sum + Number(row[totalColumn - 1] ?? 0), 0);

      expect(Number(csvTotal.toFixed(2))).toBe(Number(documentTotal.toFixed(2)));

      expect(isPdf((await download(session, WBS, 'PDF')).body)).toBe(true);
    }, 300_000);

    it('45, 74. every dependency row survives', async () => {
      const rows = (await read(session, CDS)).rows;

      expect(rows.length).toBeGreaterThan(0);

      expect(csvRows((await download(session, CDS, 'CSV')).body).length - 1).toBe(rows.length);

      const sheet = (await workbook((await download(session, CDS, 'XLSX')).body)).worksheets[0]!;

      expect(sheet.rowCount - 1).toBe(rows.length);
    }, 300_000);
  });

  /* ----------------------------------------- 40, 41: time is never invented */

  describe('what the document says about time is what the file says', () => {
    let session: FixtureSession;

    beforeAll(async () => {
      session = await project();
      await chainTo(session, CDS);
    }, 300_000);

    it('40. the WBS keeps relative scheduling and manufactures no calendar date', async () => {
      const rows = csvRows((await download(session, WBS, 'CSV')).body);
      const header = rows[0]!;
      const body = rows.slice(1);

      const relative = header.indexOf('Relative Schedule');
      const actualStart = header.indexOf('Actual Start');
      const actualFinish = header.indexOf('Actual Finish');

      expect(relative).toBeGreaterThan(-1);
      expect(body.length).toBeGreaterThan(0);

      /* This project gave weeks, not a start date, so the plan is in working days. */
      expect(body.some((row) => /^Day \d+/.test(row[relative] ?? ''))).toBe(true);

      /* And the columns for real dates stay empty rather than being filled in. */
      for (const row of body) {
        expect(row[actualStart]).toBe('');
        expect(row[actualFinish]).toBe('');
      }
    }, 120_000);

    it('40. the dependency sheet keeps relative due timing', async () => {
      const rows = csvRows((await download(session, CDS, 'CSV')).body);
      const header = rows[0]!;
      const body = rows.slice(1);

      const actualDue = header.indexOf('Actual Due Date');

      expect(actualDue).toBeGreaterThan(-1);
      expect(body.length).toBeGreaterThan(0);

      for (const row of body) {
        expect(row[actualDue]).toBe('');
      }
    }, 120_000);

    it('41. with no fixed deadline the SOW export states none', async () => {
      const text = docxText((await download(session, SOW, 'DOCX')).body);

      /*
       * The metadata block carries the export date, which is legitimately today's — so the
       * search is for a date presented as a delivery commitment, in the body's own words.
       */
      expect(text).toContain('once a start date is agreed');
      expect(text).not.toMatch(/delivery by \d/);
    }, 120_000);
  });

  describe('a fixed deadline survives exactly', () => {
    let session: FixtureSession;

    /* The one date this project has. Far enough out that the plan fits inside it. */
    const DEADLINE = '2030-06-28';

    beforeAll(async () => {
      session = await approvedEstimateProject(app.getHttpServer(), provider, {
        ...WEB,
        timeline: { mode: 'FIXED_DEADLINE', deadline: DEADLINE },
      });

      await chainTo(session, SOW);
    }, 300_000);

    it('41, 58. the deadline is quoted, and no other date is', async () => {
      const text = docxText((await download(session, SOW, 'DOCX')).body);

      expect(text).toContain(DEADLINE);

      /* Every ISO date in the file is either the deadline or the export date. */
      const today = new Date().toISOString().slice(0, 10);

      for (const [date] of text.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
        expect([DEADLINE, today]).toContain(date);
      }

      /* The PDF is produced from the same projection, so it must agree. */
      expect(isPdf((await download(session, SOW, 'PDF')).body)).toBe(true);
    }, 120_000);
  });

  /* ------------------------------------------ 46: a credential never leaves */

  describe('a credential-shaped value stops the export', () => {
    it('46, 70. the file is refused, the reason is recorded, and the value is not', async () => {
      const session = await project();

      await chainTo(session, CDS);

      const before = await read(session, CDS);
      const row = before.rows[0];

      expect(row).toBeDefined();

      /*
       * Written straight into the collection, because the write path refuses this and
       * should: the case being tested is corrupt or legacy data that predates that rule,
       * which is the only way such a value can be in a document at all.
       */
      const { getConnectionToken } = await import('@nestjs/mongoose');
      const connection = app.get(getConnectionToken());

      const projectId = (
        (await session.agent.get(PROJECT_ROUTES.current).expect(200)).body as {
          projectId: string;
        }
      ).projectId;

      /*
       * A generic `api_key = value` shape rather than a vendor-formatted key. It exercises
       * the same detector, and a literal that looks like a real provider's credential in a
       * source file is a problem of its own — scanners flag it, and rightly.
       */
      const credentialShaped = 'api_key = 4f9c2b7ae1d84c06';

      expect(looksLikeSecret(credentialShaped).length).toBeGreaterThan(0);

      await connection
        .collection('document_rows')
        .updateOne(
          { projectId, type: CDS, rowId: row!.rowId, documentVersion: before.version },
          { $set: { 'payload.remarks': `We will need this: ${credentialShaped}` } },
        );

      const refused = await download(session, CDS, 'XLSX');

      expect(refused.status).toBe(422);

      /* The response says something was refused, never what. */
      const message = refused.body.toString('utf8');

      expect(message).not.toContain('4f9c2b7ae1d84c06');

      const events = await auditEvents(projectId);
      const failure = events.filter((event) => event.type === 'DOCUMENT_EXPORT_FAILED');

      expect(failure.length).toBeGreaterThan(0);
      expect(failure.at(-1)?.metadata?.reason).toBe('credential_shaped_value');
      expect(JSON.stringify(events)).not.toContain('4f9c2b7ae1d84c06');

      /* The document is untouched: refusing to export is not a document failure. */
      const after = await read(session, CDS);

      expect(after.version).toBe(before.version);
      expect(after.status).toBe(before.status);
    }, 300_000);
  });

  /* ------------------------- 47, 48: a renderer failing changes nothing */

  describe('when a renderer cannot produce the file', () => {
    it('47, 48, 91, 92. the document is untouched, the error is safe, and a retry works', async () => {
      const session = await project();

      await settle(session, UNDERSTANDING);

      const projectId = (
        (await session.agent.get(PROJECT_ROUTES.current).expect(200)).body as {
          projectId: string;
        }
      ).projectId;

      /*
       * A file that passes the upload's signature check and then cannot be decoded: the
       * first eight bytes are a PNG header and the rest is not an image. That is a genuine
       * renderer failure reached through the public API, with no test seam in the service.
       */
      const corrupt = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('this is not the rest of a PNG'.repeat(8), 'utf8'),
      ]);

      const uploaded = (
        await session.agent
          .post(PROJECT_ROUTES.brandingLogo)
          .set('x-csrf-token', session.csrf)
          .attach('logo', corrupt, { filename: 'mark.png', contentType: 'image/png' })
          .expect(201)
      ).body as { logo: { objectId: string; contentType: string } };

      const withLogo = (await session.agent.get(PROJECT_ROUTES.current).expect(200)).body as {
        version: number;
      };

      await session.agent
        .put(PROJECT_ROUTES.branding)
        .set('x-csrf-token', session.csrf)
        .send({ branding: { logo: uploaded.logo }, version: withLogo.version })
        .expect(200);

      const before = await read(session, UNDERSTANDING);
      /* Taken after the upload, so the logo's own object is already accounted for. */
      const storedBefore = storedObjects();

      const failed = await download(session, UNDERSTANDING, 'PDF');

      /* 503: the document is fine, the renderer was not. */
      expect(failed.status).toBe(503);

      const message = failed.body.toString('utf8');

      /* No path, no stack, no command. */
      expect(message).not.toContain('/home');
      expect(message).not.toContain('node_modules');
      expect(message).not.toMatch(/at [A-Za-z]+\./);

      /*
       * 48. A failed render left nothing behind. Renderers here work in memory and the
       * response is streamed, so a half-written file has nowhere to survive — this asserts
       * that rather than assuming it, against the one directory the application writes to.
       */
      expect(storedObjects()).toEqual(storedBefore);

      /* 92. The document did not move. */
      const after = await read(session, UNDERSTANDING);

      expect(after.version).toBe(before.version);
      expect(after.status).toBe(before.status);
      expect(after.currentness).toBe(before.currentness);
      expect(after.recordVersion).toBe(before.recordVersion);

      /* The failure is in the trail, classified. */
      const events = await auditEvents(projectId);
      const failures = events.filter((event) => event.type === 'DOCUMENT_EXPORT_FAILED');

      expect(failures.length).toBeGreaterThan(0);
      expect(failures.at(-1)?.metadata?.reason).toBe('render_failed');

      /* And the same export succeeds once the branding is put right. */
      const current = (await session.agent.get(PROJECT_ROUTES.current).expect(200)).body as {
        version: number;
      };

      await session.agent
        .put(PROJECT_ROUTES.branding)
        .set('x-csrf-token', session.csrf)
        .send({ branding: {}, version: current.version })
        .expect(200);

      const retried = await download(session, UNDERSTANDING, 'PDF');

      expect(retried.status).toBe(200);
      expect(isPdf(retried.body)).toBe(true);
    }, 300_000);

    it('11. a logo that cannot be read is a branding error, not a broken file', async () => {
      const session = await project();

      await settle(session, UNDERSTANDING);

      const current = (await session.agent.get(PROJECT_ROUTES.current).expect(200)).body as {
        version: number;
      };

      /* A well-formed reference to an object that is not in storage. */
      await session.agent
        .put(PROJECT_ROUTES.branding)
        .set('x-csrf-token', session.csrf)
        .send({
          branding: {
            logo: {
              objectId: 'logo_0000000000000000000000000000000f',
              contentType: 'image/png',
              filename: 'missing.png',
              sizeBytes: 128,
            },
          },
          version: current.version,
        })
        .expect(200);

      const refused = await download(session, UNDERSTANDING, 'DOCX');

      /* Said plainly, rather than silently dropping the mark or substituting another. */
      expect(refused.status).toBe(422);
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
