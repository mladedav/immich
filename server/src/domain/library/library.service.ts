import { AssetType, LibraryEntity, LibraryType, UserEntity } from '@app/infra/entities';
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import fs from 'fs';
import mime from 'mime';
import { basename, parse } from 'path';

import path from 'node:path';
import { IAssetRepository } from '../asset';
import { AuthUserDto } from '../auth';
import { ICryptoRepository } from '../crypto';
import { mimeTypes } from '../domain.constant';
import { IJobRepository, ILibraryJob, JobName } from '../job';
import { LibraryCrawler } from './library-crawler';
import {
  CreateLibraryDto,
  GetLibrariesDto,
  LibraryResponseDto,
  mapLibrary,
  ScanLibraryDto as RefreshLibraryDto,
  SetImportPathsDto,
} from './library.dto';
import { ILibraryRepository } from './library.repository';

@Injectable()
export class LibraryService {
  readonly logger = new Logger(LibraryService.name);
  private readonly crawler: LibraryCrawler;

  constructor(
    @Inject(ILibraryRepository) private libraryRepository: ILibraryRepository,
    @Inject(IAssetRepository) private assetRepository: IAssetRepository,
    @Inject(IJobRepository) private jobRepository: IJobRepository,
    @Inject(ICryptoRepository) private cryptoRepository: ICryptoRepository,
  ) {
    this.crawler = new LibraryCrawler();
  }

  async getCount(authUser: AuthUserDto): Promise<number> {
    return this.libraryRepository.getCountForUser(authUser.id);
  }

  async get(authUser: AuthUserDto, libraryId: string): Promise<LibraryResponseDto> {
    // TODO authorization
    //await this.access.requirePermission(authUser, Permission.LIBRARY_READ, libraryId);

    const library = await this.libraryRepository.get(libraryId);
    if (!library) {
      throw new NotFoundException('Library Not Found');
    }

    return mapLibrary(library);
  }

  async create(authUser: AuthUserDto, dto: CreateLibraryDto): Promise<LibraryResponseDto> {
    const libraryEntity = await this.libraryRepository.create({
      owner: { id: authUser.id } as UserEntity,
      name: dto.name,
      assets: [],
      type: dto.libraryType,
      importPaths: [],
      isVisible: dto.isVisible ?? true,
    });
    return mapLibrary(libraryEntity);
  }

  async getAll(authUser: AuthUserDto, dto: GetLibrariesDto): Promise<LibraryResponseDto[]> {
    if (dto.assetId) {
      // TODO
      throw new BadRequestException('Not implemented yet');
    }
    const libraries = await this.libraryRepository.getAllByUserId(authUser.id);
    return libraries.map((library) => mapLibrary(library));
  }

  async getLibraryById(authUser: AuthUserDto, libraryId: string): Promise<LibraryResponseDto> {
    // TODO
    //await this.access.requirePermission(authUser, Permission.LIBRARY_READ, libraryId);

    const libraryEntity = await this.libraryRepository.getById(libraryId);
    return mapLibrary(libraryEntity);
  }

  async getImportPaths(authUser: AuthUserDto, libraryId: string): Promise<string[]> {
    // TODO:
    //await this.access.requirePermission(authUser, Permission.LIBRARY_UPDATE, libraryId);

    const libraryEntity = await this.libraryRepository.getById(libraryId);
    return libraryEntity.importPaths;
  }

  async setImportPaths(authUser: AuthUserDto, libraryId: string, dto: SetImportPathsDto): Promise<LibraryResponseDto> {
    // TODO:
    //await this.access.requirePermission(authUser, Permission.LIBRARY_UPDATE, libraryId);

    const libraryEntity = await this.getLibraryById(authUser, libraryId);
    if (libraryEntity.type != LibraryType.IMPORT) {
      throw new BadRequestException('Can only set import paths on an Import type library');
    }
    const updatedEntity = await this.libraryRepository.setImportPaths(libraryId, dto.importPaths);
    return mapLibrary(updatedEntity);
  }

  async handleRefreshAsset(job: ILibraryJob) {
    const existingAssetEntity = await this.assetRepository.getByLibraryIdAndOriginalPath(job.libraryId, job.assetPath);

    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(job.assetPath);
    } catch (error) {
      // Can't access file, probably offline
      if (existingAssetEntity) {
        // Mark asset as offline
        await this.assetRepository.update({ id: existingAssetEntity.id, isOffline: true });
        return true;
      } else {
        // File can't be accessed and does not already exist in db
        throw new BadRequestException(error, "Can't access file");
      }
    }

    let doImport = false;

    if (job.forceRefresh) {
      // Force refresh was requested, re-read from disk
      doImport = true;
    }

    if (!existingAssetEntity) {
      // This asset is new to us, read it from disk
      doImport = true;
    } else if (stats.mtime !== existingAssetEntity.fileModifiedAt) {
      // File modification time has changed since last time we checked, re-read fro disk
      doImport = true;
    }

    if (existingAssetEntity?.isOffline) {
      // File was previously offline but is now online
      await this.assetRepository.update({ id: existingAssetEntity.id, isOffline: false });
    }

    if (!doImport) {
      // If we don't import, exit early
      return true;
    }

    // TODO: Determine file type from extension only
    const mimeType = mime.lookup(job.assetPath);
    if (!mimeType) {
      throw Error(`Cannot determine mime type of asset: ${job.assetPath}`);
    }

    if (!mimeTypes.isAsset(job.assetPath)) {
      throw new BadRequestException(`Unsupported file type ${mimeType}`);
    }

    const checksum = await this.cryptoRepository.hashFile(job.assetPath);
    const deviceAssetId = `${basename(job.assetPath)}-${stats.size}`.replace(/\s+/g, '');
    const assetType = mimeType.split('/')[0].toUpperCase() as AssetType;

    // TODO: doesn't xmp replace the file extension? Will need investigation
    let sidecarPath: string | null = null;
    try {
      await fs.promises.access(`${job.assetPath}.xmp`, fs.constants.R_OK);
      sidecarPath = `${job.assetPath}.xmp`;
    } catch (error) {}

    // TODO: In wait of refactoring the domain asset service, this function is just manually written like this
    const addedAsset = await this.assetRepository.create({
      owner: { id: job.ownerId } as UserEntity,

      library: { id: job.libraryId } as LibraryEntity,

      checksum: checksum,
      originalPath: job.assetPath,

      deviceAssetId: deviceAssetId,
      deviceId: 'Library Import',

      fileCreatedAt: stats.ctime,
      fileModifiedAt: stats.mtime,

      type: assetType,
      isFavorite: false,
      isArchived: false,
      duration: null,
      isVisible: true,
      livePhotoVideo: null,
      resizePath: null,
      webpPath: null,
      thumbhash: null,
      encodedVideoPath: null,
      tags: [],
      sharedLinks: [],
      originalFileName: parse(job.assetPath).name,
      faces: [],
      sidecarPath: sidecarPath,
      isReadOnly: true,
      isOffline: false,
    });

    await this.jobRepository.queue({
      name: JobName.METADATA_EXTRACTION,
      data: { id: addedAsset.id, source: 'upload' },
    });

    if (addedAsset.type === AssetType.VIDEO) {
      await this.jobRepository.queue({ name: JobName.VIDEO_CONVERSION, data: { id: addedAsset.id } });
    }

    return true;
  }

  async handleOfflineAsset(job: ILibraryJob) {
    const existingAssetEntity = await this.assetRepository.getByLibraryIdAndOriginalPath(job.libraryId, job.assetPath);

    if (!existingAssetEntity) {
      throw new BadRequestException(`Asset does not exist in database: ${job.assetPath}`);
    }

    if (job.emptyTrash && existingAssetEntity) {
      // Remove asset from database
      await this.assetRepository.remove(existingAssetEntity);
    } else if (existingAssetEntity) {
      // Mark asset as offline
      await this.assetRepository.update({ id: existingAssetEntity.id, isOffline: true });
    }

    return true;
  }

  async refresh(authUser: AuthUserDto, libraryId: string, dto: RefreshLibraryDto) {
    // TODO:
    //await this.access.requirePermission(authUser, Permission.LIBRARY_UPDATE, dto.libraryId);

    const library = await this.libraryRepository.getById(libraryId);

    if (library.type != LibraryType.IMPORT) {
      Logger.error('Only imported libraries can be refreshed');
      throw new InternalServerErrorException('Only imported libraries can be refreshed');
    }

    const crawledAssetPaths = (
      await this.crawler.findAllMedia({
        pathsToCrawl: library.importPaths,
      })
    ).map(path.normalize);

    for (const assetPath of crawledAssetPaths) {
      const libraryJobData: ILibraryJob = {
        assetPath: path.normalize(assetPath),
        ownerId: authUser.id,
        libraryId: libraryId,
        forceRefresh: dto.forceRefresh ?? false,
        emptyTrash: dto.emptyTrash ?? false,
      };

      await this.jobRepository.queue({ name: JobName.REFRESH_LIBRARY_FILE, data: libraryJobData });
    }
    const assetsInLibrary = await this.assetRepository.getByLibraryId([libraryId]);

    const offlineAssets = assetsInLibrary
      .map((asset) => asset.originalPath)
      .map(path.normalize)
      .filter((assetPath) => !crawledAssetPaths.includes(assetPath));

    for (const offlineAssetPath of offlineAssets) {
      const libraryJobData: ILibraryJob = {
        assetPath: offlineAssetPath,
        ownerId: authUser.id,
        libraryId: libraryId,
        forceRefresh: false,
        emptyTrash: dto.emptyTrash ?? false,
      };

      await this.jobRepository.queue({ name: JobName.OFFLINE_LIBRARY_FILE, data: libraryJobData });
    }
  }
}
