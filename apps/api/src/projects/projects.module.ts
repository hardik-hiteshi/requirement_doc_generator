import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../audit/audit.module';
import { ProjectAccessModule } from '../project-access/project-access.module';
import { ProjectLifecycleService } from './project-lifecycle.service';
import { ProjectRepository } from './project.repository';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { Project, ProjectSchema } from './schemas/project.schema';

/**
 * Project reads, section updates and deletion.
 *
 * The repository is exported because `ProjectAccessModule` needs it to verify a
 * recovery secret. That is the only cross-module dependency, and it runs through
 * the repository abstraction rather than the Mongoose model.
 */
@Module({
  imports: [
    MongooseModule.forFeature([{ name: Project.name, schema: ProjectSchema }]),
    AuditModule,
    ProjectAccessModule,
  ],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProjectLifecycleService, ProjectRepository],
  exports: [ProjectRepository, ProjectsService],
})
export class ProjectsModule {}
