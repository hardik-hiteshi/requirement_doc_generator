import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import mainConfig from '../jest.e2e.config';
import pdfConfig from '../jest.pdf.config';

/**
 * The integration suite's own shape, asserted.
 *
 * PDF extraction runs in a Jest project of its own because pdfjs cannot be
 * imported from an environment a previous suite has torn down — the reasoning is
 * in `jest.pdf.config.ts`. That design holds only while two things stay true:
 * the PDF project contains exactly one test file, and nothing in the main
 * project touches a PDF. Both are easy to break by accident months from now, and
 * neither breaks loudly: the symptom is a source stuck at QUEUED in whichever
 * suite happens to run second.
 *
 * So they are tested. This file is why "PDF correctness does not depend on run
 * order" is a checked property rather than a claim, and why adding a suite —
 * before the PDF one or anywhere else — cannot quietly reintroduce the failure.
 *
 * Reads the real configuration objects and the real directory. A test that
 * restated the patterns would pass while the configuration said something else.
 */
describe('Integration test topology (e2e)', () => {
  const TEST_DIR = __dirname;
  const FIXTURES_DIR = join(TEST_DIR, 'fixtures');
  const PDF_SUITE = 'pdf-extraction.e2e-spec.ts';

  const allSpecs = readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.e2e-spec.ts'))
    .sort();

  /** Applies a project's `testRegex` and `testPathIgnorePatterns` to a filename. */
  function selects(config: typeof mainConfig, name: string): boolean {
    const path = join(TEST_DIR, name);
    const regex = config.testRegex;

    if (typeof regex !== 'string' || !new RegExp(regex).test(path)) {
      return false;
    }

    const ignored = (config.testPathIgnorePatterns ?? []).some((pattern) =>
      new RegExp(pattern).test(path),
    );

    return !ignored;
  }

  const mainSpecs = allSpecs.filter((name) => selects(mainConfig, name));
  const pdfSpecs = allSpecs.filter((name) => selects(pdfConfig, name));

  it('gives the PDF suite a project containing nothing else', () => {
    // One file means no other environment can have been created — and therefore
    // torn down — in that process before the pdfjs import happens.
    expect(pdfSpecs).toEqual([PDF_SUITE]);
  });

  it('keeps the PDF suite out of the shared-process project', () => {
    expect(mainSpecs).not.toContain(PDF_SUITE);
  });

  it('runs every spec in exactly one of the two projects', () => {
    // Coverage cannot be lost to the split: a file that matches neither project
    // is a suite nobody runs, and one that matches both runs twice.
    expect([...mainSpecs, ...pdfSpecs].sort()).toEqual(allSpecs);
    expect(mainSpecs.filter((name) => pdfSpecs.includes(name))).toEqual([]);
  });

  it('leaves every PDF fixture to the isolated suite', () => {
    const pdfFixtures = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.pdf'));
    expect(pdfFixtures.length).toBeGreaterThan(0);

    const offenders: string[] = [];

    for (const spec of mainSpecs) {
      const source = readFileSync(join(TEST_DIR, spec), 'utf8');

      for (const pdfFixture of pdfFixtures) {
        if (source.includes(pdfFixture)) {
          offenders.push(`${spec} references ${pdfFixture}`);
        }
      }
    }

    /*
     * A PDF in a shared-process suite is the failure this whole arrangement
     * exists to prevent — and it does not have to be extracted to cause it. An
     * accepted upload leaves a queued job in a database every suite shares, and
     * the next `drainWorker` anywhere claims it.
     */
    expect(offenders).toEqual([]);
  });

  it('pins the isolated project to a single worker', () => {
    expect(pdfConfig.maxWorkers).toBe(1);
  });
});
