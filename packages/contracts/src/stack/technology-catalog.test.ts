import { describe, expect, it } from 'vitest';

import {
  CATALOG_BY_ID,
  TECHNOLOGY_CATALOG,
  findTechnology,
  resolveByName,
} from './technology-catalog.data';
import {
  CATALOG_VERSION,
  catalogEntrySchema,
  fillsCategory,
  matchesName,
  suitsProjectType,
} from './technology-catalog.contract';
import { TECHNOLOGY_CATEGORIES } from './technology-category.contract';

/**
 * The catalogue is data, so these are the tests that make it trustworthy data.
 *
 * Everything a recommendation asserts about a technology — its licence, whether
 * it can be self-hosted, what it costs to run — is copied from here into a
 * document a client reads. A typo in an id, an incompatibility pointing at
 * nothing, a licence left blank: each one becomes a false statement downstream
 * with nobody in the loop to catch it.
 */
describe('the technology catalogue', () => {
  it('validates every entry against the schema', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      const parsed = catalogEntrySchema.safeParse(item);

      expect(parsed.success, `${item.id}: ${parsed.error?.message ?? ''}`).toBe(true);
    }
  });

  it('has no duplicate ids', () => {
    const ids = TECHNOLOGY_CATALOG.map((item) => item.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no duplicate names', () => {
    const names = TECHNOLOGY_CATALOG.map((item) => item.name.toLowerCase());

    expect(new Set(names).size).toBe(names.length);
  });

  /*
   * An alias that also names another technology would silently resolve a user's
   * typed choice to the wrong entry, and they would not see it happen.
   */
  it('has no alias that collides with another entry', () => {
    const claimed = new Map<string, string>();

    for (const item of TECHNOLOGY_CATALOG) {
      for (const alias of [item.name.toLowerCase(), ...item.aliases.map((a) => a.toLowerCase())]) {
        const owner = claimed.get(alias);

        expect(owner ?? item.id, `"${alias}" is claimed by both ${owner} and ${item.id}`).toBe(
          item.id,
        );
        claimed.set(alias, item.id);
      }
    }
  });

  it('points every incompatibility at a technology that exists', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      for (const rule of item.incompatibleWith) {
        expect(
          findTechnology(rule.technologyId),
          `${item.id} says it is incompatible with "${rule.technologyId}", which is not in the catalogue`,
        ).toBeDefined();
      }
    }
  });

  it('never declares a technology incompatible with itself', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      expect(item.incompatibleWith.map((rule) => rule.technologyId)).not.toContain(item.id);
    }
  });

  it('gives every incompatibility a reason a user can read', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      for (const rule of item.incompatibleWith) {
        expect(rule.reason.length).toBeGreaterThan(10);
      }
    }
  });

  it('uses only categories the application defines', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      expect(TECHNOLOGY_CATEGORIES).toContain(item.category);

      for (const secondary of item.secondaryCategories) {
        expect(TECHNOLOGY_CATEGORIES).toContain(secondary);
      }
    }
  });

  it('never lists its own category as a secondary one', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      expect(item.secondaryCategories).not.toContain(item.category);
    }
  });

  it('stamps every entry with the current catalogue version', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      expect(item.catalogVersion).toBe(CATALOG_VERSION);
    }
  });

  it('records when every entry was last looked at', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      expect(Number.isNaN(Date.parse(item.lastReviewed))).toBe(false);
    }
  });

  /*
   * A licence is a commercial fact that reaches a client. Blank is not an
   * acceptable answer; "Proprietary" or "Varies" is, because both are true.
   */
  it('states a licence for every entry', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      expect(item.licence.trim().length, `${item.id} has no licence`).toBeGreaterThan(0);
    }
  });

  it('explains what committing to a paid technology implies', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      if (item.costPosture === 'COMMERCIAL' || item.costPosture === 'USAGE_BASED') {
        expect(
          item.commercialUseNote.trim().length,
          `${item.id} costs money and says nothing about it`,
        ).toBeGreaterThan(0);
      }
    }
  });

  /*
   * The one place the catalogue could contradict itself: something free to
   * self-host that cannot be self-hosted.
   */
  it('never calls a technology free to self-host when it cannot be', () => {
    for (const item of TECHNOLOGY_CATALOG) {
      if (item.costPosture === 'FREE_SELF_HOSTED') {
        expect(item.selfHostable, `${item.id} is FREE_SELF_HOSTED but not self-hostable`).toBe(
          true,
        );
      }
    }
  });

  it('covers every category that a project type can require', () => {
    const covered = new Set(
      TECHNOLOGY_CATALOG.flatMap((item) => [item.category, ...item.secondaryCategories]),
    );

    for (const category of [
      'web_frontend',
      'backend',
      'database',
      'mobile_framework',
      'native_android',
      'native_ios',
      'desktop_framework',
      'payment',
      'ai_model',
      'integrations',
    ] as const) {
      expect(covered, `nothing in the catalogue fills ${category}`).toContain(category);
    }
  });

  it('indexes every entry by id', () => {
    expect(CATALOG_BY_ID.size).toBe(TECHNOLOGY_CATALOG.length);
  });
});

describe('finding a technology by what someone typed', () => {
  it('matches the canonical name whatever the casing', () => {
    expect(resolveByName('PostgreSQL')?.id).toBe('postgresql');
    expect(resolveByName('postgresql')?.id).toBe('postgresql');
    expect(resolveByName('  POSTGRESQL  ')?.id).toBe('postgresql');
  });

  it('matches an alias', () => {
    expect(resolveByName('postgres')?.id).toBe('postgresql');
    expect(resolveByName('k8s')?.id).toBe('kubernetes');
    expect(resolveByName('golang')?.id).toBe('go-backend');
  });

  it('matches the id itself', () => {
    expect(resolveByName('react-native')?.id).toBe('react-native');
  });

  /* The important negative: an unknown name must not resolve to a near miss. */
  it('returns nothing for a technology it does not hold', () => {
    expect(resolveByName('PostgresQL Enterprise Edition')).toBeUndefined();
    expect(resolveByName('CobolWeb')).toBeUndefined();
    expect(resolveByName('')).toBeUndefined();
    expect(resolveByName('   ')).toBeUndefined();
  });

  it('matches names case-insensitively through the helper too', () => {
    const postgres = findTechnology('postgresql');

    expect(postgres).toBeDefined();
    expect(matchesName(postgres!, 'Postgres')).toBe(true);
    expect(matchesName(postgres!, 'MySQL')).toBe(false);
  });
});

describe('what a technology can be used for', () => {
  it('lets a technology fill its own category', () => {
    const postgres = findTechnology('postgresql')!;

    expect(fillsCategory(postgres, 'database')).toBe(true);
  });

  /* PostgreSQL with pgvector really is both, and duplicating the entry to say
     so would let the two copies drift apart. */
  it('lets a technology fill a secondary category', () => {
    const postgres = findTechnology('postgresql')!;

    expect(fillsCategory(postgres, 'vector_storage')).toBe(true);
    expect(fillsCategory(postgres, 'web_frontend')).toBe(false);
  });

  it('treats an empty project-type list as no opinion rather than none', () => {
    const postgres = findTechnology('postgresql')!;

    expect(postgres.supportedProjectTypes).toEqual([]);
    expect(suitsProjectType(postgres, 'WEBSITE')).toBe(true);
    expect(suitsProjectType(postgres, 'AI_ML_SOLUTION')).toBe(true);
  });

  it('keeps a platform-specific technology to its platforms', () => {
    const swift = findTechnology('swift-ios')!;

    expect(suitsProjectType(swift, 'IOS_APPLICATION')).toBe(true);
    expect(suitsProjectType(swift, 'ANDROID_APPLICATION')).toBe(false);
    expect(suitsProjectType(swift, 'WEBSITE')).toBe(false);
  });
});
