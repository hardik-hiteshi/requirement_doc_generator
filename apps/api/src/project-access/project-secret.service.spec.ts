import { PROJECT_ID_PATTERN, RECOVERY_SECRET_PATTERN } from '@wdrg/contracts';

import { ProjectSecretService } from './project-secret.service';

describe('ProjectSecretService', () => {
  const service = new ProjectSecretService();

  describe('generateProjectId', () => {
    it('matches the published identifier format', () => {
      expect(service.generateProjectId()).toMatch(PROJECT_ID_PATTERN);
    });

    it('never repeats across a large sample', () => {
      const ids = new Set(Array.from({ length: 2_000 }, () => service.generateProjectId()));
      expect(ids.size).toBe(2_000);
    });

    it('uses only the Crockford alphabet, excluding I, L, O and U', () => {
      const body = service.generateProjectId().slice('prj_'.length);
      expect(body).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/);
      expect(body).not.toMatch(/[ILOU]/);
    });

    it('spreads across the alphabet rather than favouring a few characters', () => {
      const characters = Array.from({ length: 500 }, () => service.generateProjectId())
        .map((id) => id.slice(4))
        .join('');
      const distinct = new Set(characters);

      // A biased or truncated generator would collapse to a subset.
      expect(distinct.size).toBeGreaterThan(28);
    });
  });

  describe('generateRecoverySecret', () => {
    it('matches the published secret format', () => {
      expect(service.generateRecoverySecret()).toMatch(RECOVERY_SECRET_PATTERN);
    });

    it('is 256 bits of base64url, safe in a URL fragment without escaping', () => {
      const secret = service.generateRecoverySecret();
      expect(secret).toHaveLength(43);
      expect(secret).not.toMatch(/[+/=]/);
    });

    it('never repeats across a large sample', () => {
      const secrets = new Set(
        Array.from({ length: 2_000 }, () => service.generateRecoverySecret()),
      );
      expect(secrets.size).toBe(2_000);
    });
  });

  describe('hashSecret', () => {
    it('produces a self-describing record', async () => {
      const stored = await service.hashSecret('a-secret');

      expect(stored.algorithm).toBe('scrypt');
      expect(stored.version).toBe(1);
      expect(stored.salt).toBeTruthy();
      expect(stored.hash).toBeTruthy();
    });

    it('never contains the raw secret', async () => {
      const secret = service.generateRecoverySecret();
      const stored = await service.hashSecret(secret);

      expect(JSON.stringify(stored)).not.toContain(secret);
    });

    it('salts, so the same secret hashes differently every time', async () => {
      const secret = 'identical-secret';
      const first = await service.hashSecret(secret);
      const second = await service.hashSecret(secret);

      expect(first.salt).not.toBe(second.salt);
      expect(first.hash).not.toBe(second.hash);
    });
  });

  describe('verifySecret', () => {
    it('accepts the correct secret', async () => {
      const secret = service.generateRecoverySecret();
      const stored = await service.hashSecret(secret);

      await expect(service.verifySecret(secret, stored)).resolves.toBe(true);
    });

    it('rejects a wrong secret', async () => {
      const stored = await service.hashSecret(service.generateRecoverySecret());

      await expect(service.verifySecret(service.generateRecoverySecret(), stored)).resolves.toBe(
        false,
      );
    });

    it('rejects a secret differing by one character', async () => {
      const secret = service.generateRecoverySecret();
      const stored = await service.hashSecret(secret);
      const nearMiss = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;

      await expect(service.verifySecret(nearMiss, stored)).resolves.toBe(false);
    });

    it('rejects an unknown hash algorithm rather than assuming', async () => {
      const stored = await service.hashSecret('secret');

      await expect(
        service.verifySecret('secret', { ...stored, algorithm: 'md5' as 'scrypt' }),
      ).resolves.toBe(false);
    });

    it('returns false rather than throwing on a corrupted record', async () => {
      const stored = await service.hashSecret('secret');

      await expect(
        service.verifySecret('secret', { ...stored, salt: 'not-base64!!', hash: '' }),
      ).resolves.toBe(false);
    });

    it('rejects an empty candidate', async () => {
      const stored = await service.hashSecret(service.generateRecoverySecret());

      await expect(service.verifySecret('', stored)).resolves.toBe(false);
    });
  });
});
