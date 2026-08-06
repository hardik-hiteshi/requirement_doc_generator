import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AppConfigModule, AppConfigService } from '../config';

/**
 * MongoDB connection for the application.
 *
 * `bufferCommands: false` is deliberate: with buffering on, a query issued while
 * the connection is down waits silently until it times out, turning an outage
 * into a pile of slow requests. Off, it fails immediately and the readiness
 * probe reports the real state.
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        uri: config.database.uri,
        serverSelectionTimeoutMS: config.database.connectTimeoutMs,
        connectTimeoutMS: config.database.connectTimeoutMs,
        bufferCommands: false,
        autoIndex: !config.isProduction,
      }),
    }),
  ],
  exports: [MongooseModule],
})
export class DatabaseModule {}
