import { FEATURE_CSV_COLUMNS, type DocumentSnapshot, type ProjectDocument } from '@wdrg/contracts';

import { proseProjection, tableProjection } from './document-projections';
import type { Block } from './export-projection';

/**
 * The projections, which decide what a file contains before any renderer is involved.
 *
 * Column order is the point of most of these. A spreadsheet whose columns move between
 * releases breaks every saved filter, formula and import script pointed at it, and the
 * only way that stays stable is if it is asserted rather than assumed.
 *
 * The other half is honesty about state: a draft has to say it is a draft, an issued
 * version has to say it is issued, and a document with nothing in it has to say that
 * plainly instead of rendering an empty table or refusing to export.
 */

function snapshot(overrides: Partial<DocumentSnapshot> = {}): DocumentSnapshot {
  return {
    documentId: 'doc_1',
    type: 'OUR_UNDERSTANDING',
    projectId: 'prj_1',
    version: 3,
    status: 'APPROVED',
    currentness: 'CURRENT',
    title: 'Our Understanding',
    prerequisiteVersions: {},
    sections: [],
    features: [],
    rows: [],
    blockers: [],
    outdatedReasons: [],
    schemaVersion: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    recordVersion: 4,
    ...overrides,
  } as DocumentSnapshot;
}

const prose = (document: ProjectDocument, given: DocumentSnapshot) =>
  proseProjection({
    document,
    snapshot: given,
    projectName: 'Acme portal',
    branding: undefined,
    exportedAt: new Date('2026-08-13T10:00:00.000Z'),
  });

/** Every string a prose projection would put on the page. */
function proseText(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
        case 'note':
          return block.text;
        case 'bullets':
          return block.items.join(' ');
        case 'table':
          return [...block.columns, ...block.rows.flat()].join(' ');
        default:
          return '';
      }
    })
    .join('\n');
}

describe('the structured projections', () => {
  it('keeps the Feature Listing to its eight columns, in the contract order', () => {
    const projection = tableProjection('FEATURE_LISTING', snapshot({ type: 'FEATURE_LISTING' }));

    expect(projection.columns.map((column) => column.header)).toEqual([...FEATURE_CSV_COLUMNS]);
  });

  it('gives the WBS every field the plan carries, in a fixed order', () => {
    const projection = tableProjection(
      'WORK_BREAKDOWN_STRUCTURE',
      snapshot({ type: 'WORK_BREAKDOWN_STRUCTURE' }),
    );

    const headers = projection.columns.map((column) => column.header);

    /* The named fields, and each exactly once. */
    for (const header of [
      'WBS ID',
      'Parent ID',
      'Sequence',
      'Phase',
      'Module',
      'Sub Module',
      'Feature',
      'Task',
      'Description',
      'Requirements',
      'Features',
      'Estimate Units',
      'Owner Role',
      'Total Effort',
      'Relative Schedule',
      'Predecessors',
      'Dependency Type',
      'Parallelizable',
      'Milestone',
      'Deliverable',
      'Critical Path',
      'Status',
      'Notes',
    ]) {
      expect(headers.filter((entry) => entry === header)).toHaveLength(1);
    }

    /* Identity first, then the work, then effort, then timing: stable and readable. */
    expect(headers.indexOf('WBS ID')).toBeLessThan(headers.indexOf('Task'));
    expect(headers.indexOf('Task')).toBeLessThan(headers.indexOf('Total Effort'));
    expect(headers.indexOf('Total Effort')).toBeLessThan(headers.indexOf('Relative Schedule'));
  });

  it('gives the dependency sheet the fields the specification lists', () => {
    const projection = tableProjection(
      'CLIENT_DEPENDENCY_SHEET',
      snapshot({ type: 'CLIENT_DEPENDENCY_SHEET' }),
    );

    expect(projection.columns.map((column) => column.header)).toEqual([
      'Dependency ID',
      'Category',
      'Module',
      'Feature',
      'Client Dependency',
      'Detailed Description',
      'Purpose',
      'Related Requirement IDs',
      'Related Feature IDs',
      'Related WBS IDs',
      'Client Owner',
      'Internal Owner',
      'Required Phase/Milestone',
      'Actual Due Date',
      'Relative Due',
      'Priority',
      'Blocking',
      'Impact If Delayed',
      'Source',
      'Expected Format',
      'Status',
      'Requested Date',
      'Received Date',
      'Validation State',
      'Remarks',
    ]);
  });

  it('has no structured projection for a prose-only document', () => {
    expect(() => tableProjection('ASSUMPTIONS', snapshot({ type: 'ASSUMPTIONS' }))).toThrow();
  });

  it('produces a header row and nothing else when a document has no rows', () => {
    const projection = tableProjection(
      'CLIENT_DEPENDENCY_SHEET',
      snapshot({ type: 'CLIENT_DEPENDENCY_SHEET' }),
    );

    expect(projection.rows).toEqual([]);
    expect(projection.columns.length).toBeGreaterThan(0);
  });
});

describe('what a readable export says about itself', () => {
  it('states the project, the document, the version and the decision', () => {
    const text = proseText(prose('OUR_UNDERSTANDING', snapshot()).blocks);

    expect(text).toContain('Acme portal');
    expect(text).toContain('Our Understanding');
    expect(text).toContain('3');
    expect(text).toContain('Approved');
  });

  it('marks a draft as a draft', () => {
    const text = proseText(prose('OUR_UNDERSTANDING', snapshot({ status: 'DRAFT' })).blocks);

    expect(text).toContain('Draft');
    expect(text).not.toContain('Approved');
  });

  it('marks a document awaiting revision', () => {
    const text = proseText(
      prose('OUR_UNDERSTANDING', snapshot({ status: 'NEEDS_REVISION' })).blocks,
    );

    /* The label a client reads, not the internal status name. */
    expect(text).toContain('Needs changes');
    expect(text).not.toContain('NEEDS_REVISION');
  });

  it('represents an issued version as issued', () => {
    const text = proseText(
      prose('OUR_UNDERSTANDING', snapshot({ status: 'FINAL', finalAt: '2026-08-10T00:00:00.000Z' }))
        .blocks,
    );

    expect(text).toContain('Issued');
  });

  it('says why an approved document is out of date, in the words it was given', () => {
    const text = proseText(
      prose(
        'OUR_UNDERSTANDING',
        snapshot({
          currentness: 'OUTDATED',
          outdatedReasons: [
            {
              kind: 'baseline_changed',
              summary: 'The approved requirements changed after this version.',
            },
          ] as never,
        }),
      ).blocks,
    );

    /* Said professionally rather than with an alarming stamp, and without hedging. */
    expect(text).toContain('written against inputs that have since changed');
    expect(text).toContain('reproduced as it stands');
    expect(text).toContain('The approved requirements changed after this version.');
  });

  it('exports an approved Assumptions document that has nothing in it', () => {
    const projection = prose('ASSUMPTIONS', snapshot({ type: 'ASSUMPTIONS' }));
    const text = proseText(projection.blocks);

    /* An honest empty result: not an error, and not an empty table either. */
    expect(projection.blocks.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain('no ');
    expect(projection.blocks.some((block) => block.kind === 'table')).toBe(false);
  });

  it('lays the Feature Listing out landscape, because eight columns need the width', () => {
    expect(prose('FEATURE_LISTING', snapshot({ type: 'FEATURE_LISTING' })).landscape).toBe(true);
  });

  it('carries no database ids into a client-facing document', () => {
    const text = proseText(
      prose('OUR_UNDERSTANDING', snapshot({ documentId: 'doc_secret_internal_id' })).blocks,
    );

    expect(text).not.toContain('doc_secret_internal_id');
    expect(text).not.toContain('prj_1');
  });
});
