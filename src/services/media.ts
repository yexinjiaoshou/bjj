import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { appDataDir, basename, join } from "@tauri-apps/api/path";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BaseDirectory,
  copyFile,
  exists,
  mkdir,
  remove,
  stat,
} from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Attachment } from "../domain/types";

const MEDIA_DIRECTORY = "media";
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v"];
const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const IMPORTED_MEDIA_PATH =
  new RegExp(`^media/(?:${UUID_PATTERN}/)?${UUID_PATTERN}\\.([a-z0-9]+)$`);
const CONTENT_MEDIA_PATH =
  /^media\/blobs\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.([a-z0-9]+)$/;
const STAGED_VIDEO_PATH = new RegExp(
  `^media/(?:${UUID_PATTERN}/)?staging/${UUID_PATTERN}\\.([a-z0-9]+)$`,
);
const MEDIA_DIRECTORY_PATH = new RegExp(`^media(?:/${UUID_PATTERN})?$`);

type MediaKind = Extract<Attachment["kind"], "image" | "video">;

export type VideoQuality = "compact" | "balanced" | "high" | "original";

export interface VideoImportDraft {
  id: string;
  ownerType: Attachment["ownerType"];
  ownerId: string;
  title: string;
  mediaDirectory: string;
  databaseUrl: string;
  sourceRelativePath: string;
  previewUrl: string;
}

export interface VideoImportOptions {
  quality: VideoQuality;
  startSeconds: number | null;
  endSeconds: number | null;
}

export interface MediaGarbageCollectionReport {
  dryRun: boolean;
  librariesScanned: number;
  referencedBlobs: number;
  reclaimableFiles: number;
  reclaimablePartialFiles: number;
  reclaimableBytes: number;
  staleRecords: number;
  removedFiles: number;
  removedPartialFiles: number;
  removedBytes: number;
  removedRecords: number;
}

interface NativeMediaBlob {
  blobHash: string;
  relativePath: string;
  mimeType: string;
  fileExtension: string;
  byteSize: number;
}

interface StagedMediaFile {
  byteSize: number;
  fileName: string | null;
}

interface SelectedMediaFile {
  sourcePath: string;
  extension: string;
  fileName: string;
}

function supportedExtensions(kind: MediaKind) {
  return kind === "image" ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
}

function validateFileSize(kind: MediaKind, size: number) {
  const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (size > limit) {
    const label = kind === "image" ? "100 MB" : "4 GB";
    throw new Error(`${kind === "image" ? "Image" : "Video"} exceeds ${label}`);
  }
}

function isAndroidContentUri(path: string) {
  return path.startsWith("content://");
}

function isAndroidRuntime() {
  return /Android/i.test(navigator.userAgent);
}

function mediaTitle(fileName: string, extension: string, kind: MediaKind) {
  const title = fileName.replace(new RegExp(`\\.${extension}$`, "i"), "").trim();
  if (!title || /^\d+$/.test(title)) {
    return kind === "video" ? "Imported video" : "Imported image";
  }
  return title;
}

function validateMediaDirectory(mediaDirectory: string) {
  if (!MEDIA_DIRECTORY_PATH.test(mediaDirectory)) {
    throw new Error("Invalid database media directory");
  }
}

async function inspectMediaFile(
  kind: MediaKind,
  sourcePath: string,
): Promise<SelectedMediaFile> {
  const extensions = supportedExtensions(kind);
  const fileName = await basename(sourcePath);
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (!extensions.includes(extension)) {
    throw new Error(`Unsupported ${kind} file type`);
  }
  if (!isAndroidContentUri(sourcePath)) {
    const fileInfo = await stat(sourcePath);
    if (!fileInfo.isFile) {
      throw new Error("The selected item is not a file");
    }
    validateFileSize(kind, fileInfo.size);
  }
  return { sourcePath, extension, fileName };
}

async function chooseMediaFile(kind: MediaKind) {
  const sourcePath = await open({
    title: kind === "image" ? "Choose an image" : "Choose a video",
    multiple: false,
    directory: false,
    fileAccessMode: "copy",
    filters: [
      {
        name: kind === "image" ? "Images" : "Videos",
        extensions: supportedExtensions(kind),
      },
    ],
  });
  return sourcePath ? inspectMediaFile(kind, sourcePath) : null;
}

async function copySelectedMediaFile(
  kind: MediaKind,
  sourcePath: string,
  destinationRelativePath: string,
): Promise<string | null> {
  if (isAndroidContentUri(sourcePath)) {
    const stagedFile = await invoke<StagedMediaFile>("stage_media_file", {
      sourceUri: sourcePath,
      destinationRelativePath,
      mediaKind: kind,
    });
    validateFileSize(kind, stagedFile.byteSize);
    return stagedFile.fileName;
  }
  await copyFile(sourcePath, destinationRelativePath, {
    toPathBaseDir: BaseDirectory.AppData,
  });
  return null;
}

async function resolveAppDataMediaUrl(relativePath: string) {
  if (
    !IMPORTED_MEDIA_PATH.test(relativePath) &&
    !CONTENT_MEDIA_PATH.test(relativePath) &&
    !STAGED_VIDEO_PATH.test(relativePath)
  ) {
    throw new Error("Invalid app media path");
  }
  if (!isTauri()) {
    return relativePath;
  }
  if (isAndroidRuntime()) {
    return invoke<string>("resolve_media_preview_url", { relativePath });
  }
  return convertFileSrc(await join(await appDataDir(), relativePath));
}

function isImportedMediaAttachment(attachment: Attachment) {
  if (attachment.kind !== "image" && attachment.kind !== "video") {
    return false;
  }
  const contentMatch = CONTENT_MEDIA_PATH.exec(attachment.value);
  if (contentMatch) {
    return Boolean(
      contentMatch[1] === contentMatch[2].slice(0, 2) &&
      (!attachment.blobHash || attachment.blobHash === contentMatch[2]) &&
      supportedExtensions(attachment.kind).includes(contentMatch[3]),
    );
  }
  const legacyMatch = IMPORTED_MEDIA_PATH.exec(attachment.value);
  return Boolean(
    legacyMatch && supportedExtensions(attachment.kind).includes(legacyMatch[1]),
  );
}

async function ingestMediaAttachment(
  databaseUrl: string,
  attachment: Attachment,
): Promise<Attachment> {
  const blob = await invoke<NativeMediaBlob>("ingest_media_blob", {
    databaseUrl,
    relativePath: attachment.value,
  });
  return {
    ...attachment,
    value: blob.relativePath,
    blobHash: blob.blobHash,
    mimeType: blob.mimeType,
    fileExtension: blob.fileExtension,
    byteSize: blob.byteSize,
  };
}

export function normalizeHttpUrl(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https links are supported");
  }
  return url.toString();
}

export async function pickMediaAttachment(
  ownerType: Attachment["ownerType"],
  ownerId: string,
  kind: MediaKind,
  mediaDirectory = MEDIA_DIRECTORY,
  databaseUrl = "sqlite:rollmap.db",
): Promise<Attachment | null> {
  if (!isTauri()) {
    throw new Error("Media import is available in the desktop app");
  }

  validateMediaDirectory(mediaDirectory);
  const selectedFile = await chooseMediaFile(kind);
  if (!selectedFile) {
    return null;
  }

  const id = crypto.randomUUID();
  const relativePath = `${mediaDirectory}/${id}.${selectedFile.extension}`;
  await mkdir(mediaDirectory, {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });
  const copiedFileName = await copySelectedMediaFile(
    kind,
    selectedFile.sourcePath,
    relativePath,
  );
  const fileName = copiedFileName ?? selectedFile.fileName;

  return ingestMediaAttachment(databaseUrl, {
    id,
    ownerType,
    ownerId,
    kind,
    title: mediaTitle(fileName, selectedFile.extension, kind),
    value: relativePath,
  });
}

export async function prepareVideoImport(
  ownerType: Attachment["ownerType"],
  ownerId: string,
  mediaDirectory = MEDIA_DIRECTORY,
  databaseUrl = "sqlite:rollmap.db",
): Promise<VideoImportDraft | null> {
  if (!isTauri()) {
    throw new Error("Video import is available in the desktop app");
  }
  validateMediaDirectory(mediaDirectory);
  const selectedFile = await chooseMediaFile("video");
  if (!selectedFile) {
    return null;
  }

  return stageVideoImport(
    ownerType,
    ownerId,
    selectedFile,
    mediaDirectory,
    databaseUrl,
  );
}

export async function prepareVideoImportFromPath(
  ownerType: Attachment["ownerType"],
  ownerId: string,
  sourcePath: string,
  mediaDirectory = MEDIA_DIRECTORY,
  databaseUrl = "sqlite:rollmap.db",
): Promise<VideoImportDraft> {
  if (!isTauri()) {
    throw new Error("Video import is available in the desktop app");
  }
  validateMediaDirectory(mediaDirectory);
  return stageVideoImport(
    ownerType,
    ownerId,
    await inspectMediaFile("video", sourcePath),
    mediaDirectory,
    databaseUrl,
  );
}

async function stageVideoImport(
  ownerType: Attachment["ownerType"],
  ownerId: string,
  selectedFile: SelectedMediaFile,
  mediaDirectory: string,
  databaseUrl: string,
): Promise<VideoImportDraft> {
  const id = crypto.randomUUID();
  const stagingDirectory = `${mediaDirectory}/staging`;
  const sourceRelativePath = `${stagingDirectory}/${id}.${selectedFile.extension}`;
  await mkdir(stagingDirectory, {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });
  const copiedFileName = await copySelectedMediaFile(
    "video",
    selectedFile.sourcePath,
    sourceRelativePath,
  );
  const fileName = copiedFileName ?? selectedFile.fileName;

  return {
    id,
    ownerType,
    ownerId,
    title: mediaTitle(fileName, selectedFile.extension, "video"),
    mediaDirectory,
    databaseUrl,
    sourceRelativePath,
    previewUrl: await resolveAppDataMediaUrl(sourceRelativePath),
  };
}

export async function finishVideoImport(
  draft: VideoImportDraft,
  options: VideoImportOptions,
): Promise<Attachment> {
  const isClip = options.startSeconds !== null && options.endSeconds !== null;
  if (
    isClip &&
    (options.startSeconds! < 0 || options.endSeconds! - options.startSeconds! < 0.1)
  ) {
    throw new Error("Choose a video clip at least 0.1 seconds long");
  }
  const value = `${draft.mediaDirectory}/${draft.id}.m4v`;
  await invoke("process_video", {
    operationId: draft.id,
    inputRelativePath: draft.sourceRelativePath,
    outputRelativePath: value,
    quality: options.quality,
    startSeconds: isClip ? options.startSeconds : null,
    durationSeconds: isClip ? options.endSeconds! - options.startSeconds! : null,
  });
  await discardVideoImport(draft);
  return ingestMediaAttachment(draft.databaseUrl, {
    id: draft.id,
    ownerType: draft.ownerType,
    ownerId: draft.ownerId,
    kind: "video",
    title: draft.title,
    value,
  });
}

export function canCancelVideoProcessing() {
  return isTauri() && isAndroidRuntime();
}

export function isVideoProcessingCancelled(error: unknown) {
  return String(error).toLowerCase().includes("video processing cancelled");
}

export async function cancelVideoProcessing(operationId: string) {
  return invoke<boolean>("cancel_video_processing", { operationId });
}

export async function discardVideoImport(draft: VideoImportDraft) {
  if (
    isTauri() &&
    STAGED_VIDEO_PATH.test(draft.sourceRelativePath) &&
    (await exists(draft.sourceRelativePath, { baseDir: BaseDirectory.AppData }))
  ) {
    await remove(draft.sourceRelativePath, { baseDir: BaseDirectory.AppData });
  }
}

export async function resolveMediaUrl(attachment: Attachment) {
  if (attachment.kind !== "image" && attachment.kind !== "video") {
    throw new Error("Only media attachments have preview URLs");
  }
  if (attachment.blobHash && !attachment.value) {
    throw new Error("Media file has not been downloaded");
  }
  if (!isImportedMediaAttachment(attachment)) {
    throw new Error("Invalid imported media path");
  }
  if (!isTauri()) {
    return attachment.value;
  }
  return resolveAppDataMediaUrl(attachment.value);
}

export async function deleteImportedMedia(attachment: Attachment) {
  if (attachment.blobHash) {
    return;
  }
  if (
    !isImportedMediaAttachment(attachment) ||
    !isTauri()
  ) {
    return;
  }
  if (await exists(attachment.value, { baseDir: BaseDirectory.AppData })) {
    await remove(attachment.value, { baseDir: BaseDirectory.AppData });
  }
}

export async function collectMediaGarbage(dryRun: boolean) {
  if (!isTauri()) {
    throw new Error("Media cleanup is available only in the native app");
  }
  return invoke<MediaGarbageCollectionReport>("collect_media_garbage", {
    dryRun,
  });
}

export async function downloadMediaAttachment(
  syncLibraryId: string,
  attachment: Attachment,
) {
  if (!isTauri()) {
    throw new Error("Media download is available only in the native app");
  }
  if (!attachment.blobHash) {
    throw new Error("Attachment does not reference a media object");
  }
  return invoke<NativeMediaBlob>("download_media_blob", {
    syncLibraryId,
    blobHash: attachment.blobHash,
  });
}

export async function openAttachment(attachment: Attachment) {
  if (attachment.kind !== "link") {
    return;
  }
  await openUrl(normalizeHttpUrl(attachment.value));
}