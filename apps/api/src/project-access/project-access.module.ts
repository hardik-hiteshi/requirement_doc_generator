import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../audit/audit.module';
import { ProjectRepository } from '../projects/project.repository';
import { Project, ProjectSchema } from '../projects/schemas/project.schema';
import { ProjectAccessController } from './project-access.controller';
import { ProjectAccessService } from './project-access.service';
import { ProjectSecretService } from './project-secret.service';
import { ProjectSessionGuard } from './project-session.guard';
import { ProjectSessionService } from './project-session.service';

/**
 * Anonymous access: creating projects, exchanging recovery secrets, and the
 * session cookie that results.
 *
 * Registers the Project model itself rather than importing ProjectsModule, which
 * would be circular — ProjectsModule needs the session guard this module
 * provides. Both bind the same schema, and Mongoose returns the same underlying
 * model, so there is one connection and one collection either way.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Project.name, schema: ProjectSchema }]),
    AuditModule,
  ],
  controllers: [ProjectAccessController],
  providers: [
    ProjectAccessService,
    ProjectSecretService,
    ProjectSessionService,
    ProjectSessionGuard,
    ProjectRepository,
  ],
  exports: [ProjectSessionService, ProjectSessionGuard, ProjectSecretService],
})
export class ProjectAccessModule {}
