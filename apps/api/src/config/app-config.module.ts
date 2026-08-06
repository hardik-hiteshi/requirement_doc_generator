import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { parseEnv } from '@wdrg/config';

import { AppConfigService } from './app-config.service';
import { apiEnvSchema } from './env.schema';

/**
 * Loads and validates configuration exactly once, at application bootstrap.
 *
 * `validate` runs before any other module is instantiated, so a misconfigured
 * deployment fails immediately with a list of every offending variable rather
 * than surfacing as a confusing runtime error on the first request.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: true,
      // Later files take lower precedence; a developer's .env.local overrides the
      // shared .env without editing a tracked file.
      envFilePath: ['.env.local', '.env', '../../.env.local', '../../.env'],
      validate: (raw: Record<string, unknown>) =>
        parseEnv(apiEnvSchema, raw as Record<string, string | undefined>),
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
