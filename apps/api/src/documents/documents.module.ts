import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AnalysisModule } from '../analysis/analysis.module';
import { AppConfigModule } from '../config/app-config.module';
import { AuditModule } from '../audit/audit.module';
import { EstimationModule } from '../estimation/estimation.module';
import { ProjectAccessModule } from '../project-access/project-access.module';
import { ProjectsModule } from '../projects/projects.module';
import { StackModule } from '../stack/stack.module';
import { DocumentsController } from './documents.controller';
import { DocumentsRepository } from './documents.repository';
import { DocumentsService } from './documents.service';
import { DocumentsAiService } from './documents-ai.service';
import { UpstreamReader } from './upstream.reader';
import { AcceptanceCriteriaComposer } from './composers/acceptance-criteria.composer';
import { AssumptionsComposer } from './composers/assumptions.composer';
import { FeatureListingComposer } from './composers/feature-listing.composer';
import { StatementOfWorkComposer } from './composers/statement-of-work.composer';
import { UnderstandingComposer } from './composers/understanding.composer';
import {
  DocumentCorrectionRecord,
  DocumentCorrectionSchema,
  DocumentFeatureRecord,
  DocumentFeatureSchema,
  DocumentRecord,
  DocumentRowRecord,
  DocumentRowSchema,
  DocumentRunRecord,
  DocumentRunSchema,
  DocumentSchema,
  DocumentSectionRecord,
  DocumentSectionSchema,
  DocumentValidationRecord,
  DocumentValidationSchema,
  DocumentVersionRecord,
  DocumentVersionSchema,
} from './schemas/document.schema';

/**
 * Phase 7's document engine.
 *
 * Depends on all three upstream phases, because a document's authority is theirs:
 * `AnalysisModule` for the approved baseline and the inference layer,
 * `StackModule` for the locked stack, `EstimationModule` for the approved
 * estimate. Reading them through their own services rather than their
 * repositories is what keeps their invariants — Phase 4's lazy outdated check
 * runs for documents too.
 *
 * The composers are providers rather than plain objects so a later document can
 * inject whatever it needs without changing the engine's constructor.
 *
 * `DocumentsAiService` takes the provider optionally, so a deployment with no
 * inference starts normally and the whole step works by hand.
 */
@Module({
  imports: [
    AppConfigModule,
    AuditModule,
    ProjectAccessModule,
    ProjectsModule,
    AnalysisModule,
    StackModule,
    EstimationModule,
    MongooseModule.forFeature([
      { name: DocumentRecord.name, schema: DocumentSchema },
      { name: DocumentSectionRecord.name, schema: DocumentSectionSchema },
      { name: DocumentFeatureRecord.name, schema: DocumentFeatureSchema },
      { name: DocumentVersionRecord.name, schema: DocumentVersionSchema },
      { name: DocumentRunRecord.name, schema: DocumentRunSchema },
      { name: DocumentValidationRecord.name, schema: DocumentValidationSchema },
      { name: DocumentCorrectionRecord.name, schema: DocumentCorrectionSchema },
      { name: DocumentRowRecord.name, schema: DocumentRowSchema },
    ]),
  ],
  controllers: [DocumentsController],
  providers: [
    DocumentsRepository,
    UpstreamReader,
    UnderstandingComposer,
    FeatureListingComposer,
    AcceptanceCriteriaComposer,
    AssumptionsComposer,
    StatementOfWorkComposer,
    DocumentsService,
    DocumentsAiService,
  ],
  exports: [DocumentsService, DocumentsRepository],
})
export class DocumentsModule {}
