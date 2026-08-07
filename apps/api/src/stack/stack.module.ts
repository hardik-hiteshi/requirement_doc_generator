import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AnalysisModule } from '../analysis/analysis.module';
import { AppConfigModule } from '../config/app-config.module';
import { AuditModule } from '../audit/audit.module';
import { ProjectAccessModule } from '../project-access/project-access.module';
import { ProjectsModule } from '../projects/projects.module';
import { StackController } from './stack.controller';
import { StackRepository } from './stack.repository';
import { StackService } from './stack.service';
import { RecommendationService } from './recommendation.service';
import {
  RecommendationRunRecord,
  RecommendationRunSchema,
  StackComponentRecord,
  StackComponentSchema,
  StackSnapshotRecord,
  StackSnapshotSchema,
} from './schemas/stack.schema';

/**
 * Phase 5's technology-stack decision workflow.
 *
 * Depends on `AnalysisModule` for two things and nothing else: the approved
 * baseline it decides against, and the inference layer Phase 4 already built.
 * **No second inference system.** The provider, the endpoint guard, the task
 * runner, the structured-output validation and the model profiles are all Phase
 * 4's, reused — adding another would mean a second set of endpoint protections
 * to keep in step with the first.
 *
 * `RecommendationService` takes the provider optionally, so a deployment with
 * no inference configured starts normally and the stack step works end to end
 * without it. That is deliberate: if choosing a stack required a model, the
 * whole workflow would inherit a dependency on one.
 */
@Module({
  imports: [
    AppConfigModule,
    AuditModule,
    ProjectAccessModule,
    ProjectsModule,
    AnalysisModule,
    MongooseModule.forFeature([
      { name: StackSnapshotRecord.name, schema: StackSnapshotSchema },
      { name: StackComponentRecord.name, schema: StackComponentSchema },
      { name: RecommendationRunRecord.name, schema: RecommendationRunSchema },
    ]),
  ],
  controllers: [StackController],
  providers: [StackRepository, StackService, RecommendationService],
  exports: [StackService, StackRepository],
})
export class StackModule {}
