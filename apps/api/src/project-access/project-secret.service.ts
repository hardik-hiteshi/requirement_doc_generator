import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import { Injectable } from '@nestjs/common';
import {
  CROCKFORD_BASE32_ALPHABET,
  PROJECT_ID_BODY_LENGTH,
  PROJECT_ID_PREFIX,
  RECOVERY_SECRET_BYTES,
} from '@wdrg/contracts';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * scrypt parameters.
 *
 * A recovery secret is 256 bits of uniform randomness, not a human-chosen
 * password, so it is not guessable by dictionary or brute force — the hash only
 * has to prevent a database leak from yielding usable credentials. These are
 * Node's defaults, which are comfortably sufficient for that job while keeping
 * verification fast enough to sit in a request path.
 */
const SCRYPT = {
  keyLength: 64,
  saltBytes: 16,
  cost: 16_384,
  blockSize: 8,
  parallelization: 1,
} as const;

/** Marker so a stored hash is self-describing and can be migrated later. */
const HASH_ALGORITHM = 'scrypt' as const;
const HASH_VERSION = 1 as const;

export interface StoredSecretHash {
  readonly algorithm: typeof HASH_ALGORITHM;
  readonly version: typeof HASH_VERSION;
  readonly salt: string;
  readonly hash: string;
}

/**
 * Generates and verifies the two values that make anonymous access work.
 *
 * The raw recovery secret exists only in the response that creates the project
 * and in whatever the user saves. It is never persisted, never logged, and never
 * recoverable — losing it loses the project, which is the honest cost of having
 * no accounts.
 */
@Injectable()
export class ProjectSecretService {
  /**
   * Generates an unguessable public project id.
   *
   * Rejection sampling keeps the output uniform over the 32-character alphabet.
   * Taking `byte % 32` instead would be subtly biased — harmless here given the
   * size of the space, but the correct version costs nothing.
   */
  generateProjectId(): string {
    const alphabet = CROCKFORD_BASE32_ALPHABET;
    let body = '';

    while (body.length < PROJECT_ID_BODY_LENGTH) {
      for (const byte of randomBytes(PROJECT_ID_BODY_LENGTH)) {
        if (body.length === PROJECT_ID_BODY_LENGTH) {
          break;
        }

        // 256 is a whole multiple of 32, so masking is already unbiased.
        body += alphabet[byte & 0b0001_1111];
      }
    }

    return `${PROJECT_ID_PREFIX}${body}`;
  }

  /** 256 bits, base64url so it is safe in a URL fragment without escaping. */
  generateRecoverySecret(): string {
    return randomBytes(RECOVERY_SECRET_BYTES).toString('base64url');
  }

  async hashSecret(secret: string): Promise<StoredSecretHash> {
    const salt = randomBytes(SCRYPT.saltBytes);
    const hash = await scrypt(secret, salt, SCRYPT.keyLength);

    return {
      algorithm: HASH_ALGORITHM,
      version: HASH_VERSION,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
    };
  }

  /**
   * Verifies a candidate secret against a stored hash.
   *
   * The comparison is timing-safe, so the time taken reveals nothing about how
   * much of the secret was correct. Length is checked first because
   * `timingSafeEqual` throws on a length mismatch — and the length of a stored
   * hash is fixed and public, so branching on it leaks nothing.
   */
  async verifySecret(secret: string, stored: StoredSecretHash): Promise<boolean> {
    if (stored.algorithm !== HASH_ALGORITHM) {
      return false;
    }

    let expected: Buffer;
    let actual: Buffer;

    try {
      expected = Buffer.from(stored.hash, 'base64');

      // Checked BEFORE deriving. A corrupted record with an empty hash would
      // otherwise make scrypt derive an empty key, and `timingSafeEqual` of two
      // empty buffers returns true — authenticating every secret against a
      // broken row. Pinning the length to the one this service produces makes
      // that unreachable.
      if (expected.length !== SCRYPT.keyLength) {
        return false;
      }

      actual = await scrypt(secret, Buffer.from(stored.salt, 'base64'), SCRYPT.keyLength);
    } catch {
      // A malformed stored hash is a data problem, not an authentication
      // decision — refuse access rather than throwing into the request path.
      return false;
    }

    if (expected.length !== actual.length) {
      return false;
    }

    return timingSafeEqual(expected, actual);
  }
}
