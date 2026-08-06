import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import {
  LegacyConversionError,
  type LegacyConversionPort,
  type LegacyConversionRequest,
  type LegacyConversionResult,
} from '../../ports';

const run = promisify(execFile);

/**
 * Legacy conversion through headless LibreOffice.
 *
 * **Off unless `LEGACY_CONVERSION_ENABLED` is set.** That is the important part
 * of this class, and it is checked before anything else happens: a deployment
 * that has not opted in gets a clear refusal rather than an attempt to run a
 * binary that is not there.
 *
 * Where it *is* enabled, conversion happens in an isolated profile directory per
 * call. LibreOffice keeps a single shared user profile by default and refuses to
 * start a second instance against it — so two concurrent conversions would
 * deadlock, and one crashed conversion would leave a lock file that breaks every
 * subsequent one. A throwaway profile makes each call independent.
 */
@Injectable()
export class LibreOfficeConversionAdapter implements LegacyConversionPort {
  private readonly logger = new Logger(LibreOfficeConversionAdapter.name);
  private available: boolean | undefined;

  constructor(private readonly config: AppConfigService) {}

  async isAvailable(): Promise<boolean> {
    if (!this.config.legacyConversion.enabled) {
      return false;
    }

    if (this.available !== undefined) {
      return this.available;
    }

    try {
      await run(this.config.legacyConversion.binary, ['--version'], { timeout: 30_000 });
      this.available = true;
      this.logger.log('Legacy conversion available');
    } catch (cause) {
      this.available = false;
      this.logger.warn(
        { binary: this.config.legacyConversion.binary, cause },
        'Legacy conversion is enabled but the converter did not run — .doc and .xls will be refused',
      );
    }

    return this.available;
  }

  async convert(request: LegacyConversionRequest): Promise<LegacyConversionResult> {
    if (!this.config.legacyConversion.enabled) {
      throw new LegacyConversionError(
        'not_configured',
        'Legacy file conversion is not enabled on this deployment.',
        false,
      );
    }

    if (!(await this.isAvailable())) {
      throw new LegacyConversionError(
        'converter_unavailable',
        'The document converter is not available.',
        false,
      );
    }

    const started = Date.now();
    const target = request.format === 'doc' ? 'docx' : 'xlsx';
    const workDir = await mkdtemp(join(tmpdir(), 'wdrg-convert-'));
    const profileDir = join(workDir, 'profile');
    const inputPath = join(workDir, `input.${request.format}`);
    const outputDir = join(workDir, 'out');

    try {
      await writeFile(inputPath, request.content, { mode: 0o600 });

      await run(
        this.config.legacyConversion.binary,
        [
          '--headless',
          // A private profile per call — see the class comment.
          `-env:UserInstallation=file://${profileDir}`,
          '--norestore',
          '--convert-to',
          target,
          '--outdir',
          outputDir,
          inputPath,
        ],
        { timeout: this.config.legacyConversion.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      );

      const produced = await readdir(outputDir).catch(() => [] as string[]);
      const converted = produced.find((name) => name.endsWith(`.${target}`));

      if (!converted) {
        // LibreOffice exits 0 even when it converts nothing, so the output
        // directory — not the exit code — is what says whether it worked.
        throw new LegacyConversionError(
          'conversion_failed',
          'The file could not be converted.',
          false,
        );
      }

      const content = await readFile(join(outputDir, converted));

      return {
        content,
        extension: target,
        durationMs: Date.now() - started,
        converter: 'libreoffice',
      };
    } catch (cause) {
      if (cause instanceof LegacyConversionError) {
        throw cause;
      }

      const message = cause instanceof Error ? cause.message : String(cause);

      if (/timed?\s*out|ETIMEDOUT|SIGTERM/i.test(message)) {
        throw new LegacyConversionError(
          'timeout',
          'Converting this file took too long and was stopped.',
          true,
          { cause },
        );
      }

      this.logger.warn({ cause, format: request.format }, 'Legacy conversion failed');
      throw new LegacyConversionError(
        'corrupted_file',
        'The file could not be converted. It may be damaged or password-protected.',
        false,
        { cause },
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
