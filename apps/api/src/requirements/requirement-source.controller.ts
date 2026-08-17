import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  addTextSourceRequestSchema,
  correctContentRequestSchema,
  sourceIdSchema,
  updateTextSourceRequestSchema,
  UPLOAD_FIELD_NAME,
  versionedSourceRequestSchema,
  type AddTextSourceRequest,
  type CorrectContentRequest,
  type RequirementSource,
  type SourceListResponse,
  type UpdateTextSourceRequest,
  type UploadResponse,
  type VersionedSourceRequest,
} from '@wdrg/contracts';
import type { Response } from 'express';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ProjectSessionGuard,
  type AuthenticatedRequest,
} from '../project-access/project-session.guard';
import { RequirementSourceService } from './requirement-source.service';
import type { FileCandidate } from './validation/file-validator';
import { RateLimit } from '../abuse/rate-limit.decorator';

/**
 * Requirement sources for the project the caller's session is bound to.
 *
 * As with every project route, the project comes from the verified session and
 * never from the request. A `sourceId` in the path is therefore scoped by that
 * session: it names a source *within the caller's own project*, and a source id
 * belonging to another project resolves to "not found" — the same answer as an
 * id that never existed, so the endpoint cannot be used to discover which
 * sources exist elsewhere.
 */
@ApiTags('requirement-sources')
@ApiUnauthorizedResponse({ description: 'No valid project session.' })
@Controller({ path: 'projects/current/sources' })
@UseGuards(ProjectSessionGuard)
export class RequirementSourceController {
  constructor(private readonly sources: RequirementSourceService) {}

  @Get()
  @ApiOperation({ summary: 'List requirement sources' })
  @ApiOkResponse({ description: 'Every source in the project, with storage usage.' })
  async list(@Req() request: AuthenticatedRequest): Promise<SourceListResponse> {
    return this.sources.list(contextOf(request));
  }

  @Post('text')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a pasted-text requirement source',
    description:
      'Pasted text is a first-class requirement source with its own lifecycle, revision history and review state — not a field on the project.',
  })
  @ApiCreatedResponse({ description: 'The created source, with its initial content.' })
  async addText(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(addTextSourceRequestSchema)) body: AddTextSourceRequest,
  ): Promise<RequirementSource> {
    return this.sources.addTextSource(body, contextOf(request));
  }

  @RateLimit('upload')
  @Post('files')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FilesInterceptor(UPLOAD_FIELD_NAME))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload requirement files',
    description:
      'Accepts several files at once and reports each independently — one rejected file never fails the batch. Every file is validated by extension, declared type and content signature before anything is stored.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        [UPLOAD_FIELD_NAME]: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ApiCreatedResponse({ description: 'One outcome per submitted file.' })
  async upload(
    @Req() request: AuthenticatedRequest,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ): Promise<UploadResponse> {
    const candidates: FileCandidate[] = (files ?? []).map((file) => ({
      // Multer decodes the multipart filename as latin1; re-decoding as UTF-8
      // is what makes a name like `Rapport été.pdf` survive intact.
      originalFilename: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      declaredMimeType: file.mimetype,
      content: file.buffer,
    }));

    return { outcomes: await this.sources.uploadFiles(candidates, contextOf(request)) };
  }

  @Get(':sourceId')
  @ApiOperation({ summary: 'Read a requirement source' })
  @ApiParam({ name: 'sourceId', example: 'src_0123456789ABCDEFGHJKMNPQRS' })
  @ApiOkResponse({ description: 'The source, with effective and original content.' })
  @ApiNotFoundResponse({ description: 'No such source in this project.' })
  async read(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId', new ZodValidationPipe(sourceIdSchema)) sourceId: string,
  ): Promise<RequirementSource> {
    return this.sources.readSource(contextOf(request), sourceId);
  }

  @Put(':sourceId/text')
  @ApiOperation({
    summary: 'Edit a pasted-text source',
    description: 'Saves a new revision and returns the source to review.',
  })
  async updateText(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId', new ZodValidationPipe(sourceIdSchema)) sourceId: string,
    @Body(new ZodValidationPipe(updateTextSourceRequestSchema)) body: UpdateTextSourceRequest,
  ): Promise<RequirementSource> {
    return this.sources.updateTextSource(sourceId, body, contextOf(request));
  }

  @Get(':sourceId/content')
  @ApiOperation({
    summary: 'Read extracted content',
    description:
      'Returns the effective content — the latest correction if there is one, otherwise the original extraction — alongside the original, so the two can be compared.',
  })
  async content(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId', new ZodValidationPipe(sourceIdSchema)) sourceId: string,
  ): Promise<RequirementSource> {
    return this.sources.readSource(contextOf(request), sourceId);
  }

  @Put(':sourceId/content/corrections')
  @ApiOperation({
    summary: 'Correct extracted content',
    description:
      'Saves corrections as a new revision. The original extraction is never overwritten and stays restorable.',
  })
  async correct(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId', new ZodValidationPipe(sourceIdSchema)) sourceId: string,
    @Body(new ZodValidationPipe(correctContentRequestSchema)) body: CorrectContentRequest,
  ): Promise<RequirementSource> {
    return this.sources.correctContent(sourceId, body, contextOf(request));
  }

  @Post(':sourceId/content/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore the original extraction',
    description:
      'Points the effective content back at revision 0. Corrections stay in the history.',
  })
  async restore(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId', new ZodValidationPipe(sourceIdSchema)) sourceId: string,
    @Body(new ZodValidationPipe(versionedSourceRequestSchema)) body: VersionedSourceRequest,
  ): Promise<RequirementSource> {
    return this.sources.restoreOriginal(sourceId, body.version, contextOf(request));
  }

  @Post(':sourceId/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a source reviewed',
    description: 'Later phases consume reviewed effective content.',
  })
  async review(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId', new ZodValidationPipe(sourceIdSchema)) sourceId: string,
    @Body(new ZodValidationPipe(versionedSourceRequestSchema)) body: VersionedSourceRequest,
  ): Promise<RequirementSource> {
    return this.sources.markReviewed(sourceId, body.version, contextOf(request));
  }

  @RateLimit('expensive')
  @Post(':sourceId/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a failed source',
    description:
      'Only a failed source whose failure could plausibly clear is retryable, and only within the configured attempt limit.',
  })
  async retry(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId', new ZodValidationPipe(sourceIdSchema)) sourceId: string,
  ): Promise<RequirementSource> {
    return this.sources.retry(sourceId, contextOf(request));
  }

  @Delete(':sourceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a requirement source',
    description: 'Soft-deletes the record and removes the stored file immediately.',
  })
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId', new ZodValidationPipe(sourceIdSchema)) sourceId: string,
  ): Promise<void> {
    await this.sources.deleteSource(sourceId, contextOf(request));
  }

  @Get(':sourceId/download')
  @ApiOperation({
    summary: 'Download the original file',
    description:
      'Streams the stored file through an authorized route. Storage keys are never exposed, so there is no URL that reaches a file without a session.',
  })
  async download(
    @Req() request: AuthenticatedRequest,
    @Param('sourceId', new ZodValidationPipe(sourceIdSchema)) sourceId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const download = await this.sources.openDownload(sourceId, contextOf(request));

    response.setHeader('Content-Type', download.contentType);
    // `attachment` so a browser never renders an uploaded file in our origin —
    // an HTML or SVG upload displayed inline would be stored XSS.
    response.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(download.filename)}`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');

    // Returned rather than piped: piping into a passthrough response races
    // Nest's own send, which ends the response before the stream has finished.
    return new StreamableFile(download.stream);
  }
}

function contextOf(request: AuthenticatedRequest): { projectId: string; correlationId: string } {
  const projectId = request.projectSession?.projectId;

  if (!projectId) {
    // Unreachable: the guard rejects before the handler runs. Throwing rather
    // than defaulting means a future refactor that removes the guard fails
    // loudly instead of quietly serving somebody else's project.
    throw new Error('Session guard did not attach a project.');
  }

  const id = (request as { id?: unknown }).id;

  return { projectId, correlationId: typeof id === 'string' ? id : 'unknown' };
}
