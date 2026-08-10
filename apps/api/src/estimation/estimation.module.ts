import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AnalysisModule } from '../analysis/analysis.module';
import { AppConfigModule } from '../config/app-config.module';
import { AuditModule } from '../audit/audit.module';
import { ProjectAccessModule } from '../project-access/project-access.module';
import { ProjectsModule } from '../projects/projects.module';
import { StackModule } from '../stack/stack.module';
import { EstimationController } from './estimation.controller';
import { EstimationRepository } from './estimation.repository';
import { EstimationService } from './estimation.service';
import { EstimationAiService } from './estimation-ai.service';
import {
  EstimateDependencyRecord,
  EstimateDependencySchema,
  EstimateSnapshotRecord,
  EstimateSnapshotSchema,
  EstimateUnitRecord,
  EstimateUnitSchema,
  EstimationRunRecord,
  EstimationRunSchema,
} from './schemas/estimation.schema';

/**
 * Phase 6's estimation and timeline planning.
 *
 * Depends on `AnalysisModule` for the approved baseline and the inference layer,
 * and on `StackModule` for the locked stack. **No second inference system** and
 * no scheduling library: the critical path, the slack and the dates are
 * arithmetic in `@wdrg/contracts`, which is why they can be unit-tested without
 * a database or a network.
 *
 * `EstimationAiService` takes the provider optionally, so a deployment with no
 * inference configured starts normally and the whole step works without it.
 */
@Module({
  imports: [
    AppConfigModule,
    AuditModule,
    ProjectAccessModule,
    ProjectsModule,
    AnalysisModule,
    StackModule,
    MongooseModule.forFeature([
      { name: EstimateSnapshotRecord.name, schema: EstimateSnapshotSchema },
      { name: EstimateUnitRecord.name, schema: EstimateUnitSchema },
      { name: EstimateDependencyRecord.name, schema: EstimateDependencySchema },
      { name: EstimationRunRecord.name, schema: EstimationRunSchema },
    ]),
  ],
  controllers: [EstimationController],
  providers: [EstimationRepository, EstimationService, EstimationAiService],
  exports: [EstimationService, EstimationRepository],
})
export class EstimationModule {}
