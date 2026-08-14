import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  BRANDING_LOGO_CONTENT_TYPES,
  brandingSchema,
  DEFAULT_BRANDING,
  updateBrandingRequestSchema,
  type Branding,
  type BrandingLogo,
  type ProjectResponse,
  type UpdateBrandingRequest,
} from '@wdrg/contracts';
import { randomUUID } from 'node:crypto';

import { AppException } from '../common/errors/app.exception';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  FILE_STORAGE_PORT,
  MALWARE_SCANNER_PORT,
  type FileStoragePort,
  type MalwareScannerPort,
} from '../ports';
import {
  ProjectSessionGuard,
  type AuthenticatedRequest,
} from '../project-access/project-session.guard';
import { ProjectRepository } from './project.repository';
import { ProjectsService } from './projects.service';

/**
 * Project-level branding: how exported documents are presented.
 *
 * One place, not seven. Branding on each document would mean seven answers to the same
 * question and a set of exports that disagree with each other — so it lives with the
 * project, beside the output preferences, and every document renders from it.
 *
 * Nothing here is document authority. Saving branding cannot move a version, change a
 * lifecycle or make anything outdated; the only thing that changes is what the next
 * generated file looks like.
 */

/** The field name the logo arrives under. Server-controlled, like the storage key. */
export const LOGO_FIELD_NAME = 'logo';

/** A logo is a mark, not a media library. Anything larger is a mistake, not a need. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/**
 * The first bytes of the only two formats accepted.
 *
 * Checked against the content rather than the declared type or the extension, both of
 * which the client controls. An SVG renamed `.png` is an XML document with script in it;
 * this is where that stops.
 */
const SIGNATURES: readonly {
  readonly contentType: 'image/png' | 'image/jpeg';
  readonly magic: readonly number[];
}[] = [
  { contentType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { contentType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
];

function detectImage(content: Buffer): 'image/png' | 'image/jpeg' | undefined {
  return SIGNATURES.find((candidate) =>
    candidate.magic.every((byte, index) => content[index] === byte),
  )?.contentType;
}

@ApiTags('Branding')
@Controller({ path: 'projects/current/branding', version: '1' })
@UseGuards(ProjectSessionGuard)
export class BrandingController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly repository: ProjectRepository,
    @Inject(FILE_STORAGE_PORT) private readonly storage: FileStoragePort,
    @Inject(MALWARE_SCANNER_PORT) private readonly scanner: MalwareScannerPort,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'How exports are presented',
    description:
      'Empty when nothing has been configured, which is a supported way to run: exports use a clean neutral default until somebody sets otherwise.',
  })
  @ApiOkResponse({ description: 'The stored branding.' })
  async read(@Req() request: AuthenticatedRequest): Promise<{ branding: Branding }> {
    const project = await this.repository.findByProjectId(this.projectId(request));

    const parsed = brandingSchema.safeParse(project?.branding ?? {});

    return { branding: parsed.success ? parsed.data : DEFAULT_BRANDING };
  }

  @Put()
  @ApiOperation({
    summary: 'Set how exports are presented',
    description:
      'Presentation only. Saving this cannot change a document version, a lifecycle status or whether anything is out of date — a newly generated file will look different, and the document it came from will not have moved.',
  })
  @ApiOkResponse({ description: 'The project, with its branding.' })
  async update(
    @Body(new ZodValidationPipe(updateBrandingRequestSchema)) body: UpdateBrandingRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProjectResponse> {
    return this.projects.updateBranding(body.branding, {
      projectId: this.projectId(request),
      correlationId: this.correlationId(request),
      version: body.version,
    });
  }

  @Post('logo')
  @UseInterceptors(FileInterceptor(LOGO_FIELD_NAME))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { [LOGO_FIELD_NAME]: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Upload the optional logo',
    description:
      'PNG or JPEG, verified by content signature rather than by filename or declared type, scanned for malware like every other upload, and stored under a server-generated id. The filename is kept for display only and is never used as a path.',
  })
  @ApiCreatedResponse({ description: 'The stored logo reference.' })
  async uploadLogo(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<{ logo: BrandingLogo }> {
    if (!file?.buffer || file.buffer.byteLength === 0) {
      throw new AppException('VALIDATION_FAILED', {
        message: 'Choose a PNG or JPEG file to use as the logo.',
        details: [{ path: LOGO_FIELD_NAME, rule: 'required', message: 'No file was uploaded.' }],
      });
    }

    if (file.buffer.byteLength > MAX_LOGO_BYTES) {
      throw new AppException('VALIDATION_FAILED', {
        message: 'That logo is larger than 2 MB. A smaller image will render better anyway.',
        details: [{ path: LOGO_FIELD_NAME, rule: 'too_large', message: 'Logo exceeds 2 MB.' }],
      });
    }

    const contentType = detectImage(file.buffer);

    if (!contentType) {
      throw new AppException('VALIDATION_FAILED', {
        message: `A logo must be a PNG or a JPEG. Accepted types: ${BRANDING_LOGO_CONTENT_TYPES.join(', ')}.`,
        details: [
          {
            path: LOGO_FIELD_NAME,
            rule: 'unsupported_type',
            /* What the bytes were, not what the client claimed they were. */
            message: 'The file content is not a PNG or JPEG image.',
          },
        ],
      });
    }

    const projectId = this.projectId(request);
    const correlationId = this.correlationId(request);

    const scan = await this.scanner.scan({ content: file.buffer, correlationId });

    if (scan.verdict === 'INFECTED') {
      throw new AppException('VALIDATION_FAILED', {
        message: 'That file was rejected by the malware scanner and has not been stored.',
        details: [
          { path: LOGO_FIELD_NAME, rule: 'malware', message: 'Scanner rejected the file.' },
        ],
      });
    }

    /* The id is generated here. Nothing the client sent reaches the storage key. */
    const objectId = `logo_${randomUUID().replace(/-/g, '')}`;

    const stored = await this.storage.put({
      key: { projectId, objectId },
      content: file.buffer,
      contentType,
      /* Kept for display beside the upload control; never used as a path. */
      originalFilename: Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200),
    });

    return {
      logo: {
        objectId,
        contentType,
        filename: Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200),
        sizeBytes: stored.sizeBytes,
      },
    };
  }

  private projectId(request: AuthenticatedRequest): string {
    const projectId = request.projectSession?.projectId;

    if (!projectId) {
      throw new Error('Session guard did not attach a project.');
    }

    return projectId;
  }

  private correlationId(request: AuthenticatedRequest): string {
    const id = (request as { id?: unknown }).id;

    return typeof id === 'string' ? id : 'unknown';
  }
}
