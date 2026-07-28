import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  isTauri: false,
  open: vi.fn(),
  stat: vi.fn(),
  mkdir: vi.fn(),
  copyFile: vi.fn(),
  exists: vi.fn(),
  remove: vi.fn(),
  extname: vi.fn(),
  basename: vi.fn(),
  appDataDir: vi.fn(),
  join: vi.fn(),
  convertFileSrc: vi.fn(),
  invoke: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: native.convertFileSrc,
  invoke: native.invoke,
  isTauri: () => native.isTauri,
}));
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: native.appDataDir,
  basename: native.basename,
  extname: native.extname,
  join: native.join,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: "AppData" },
  copyFile: native.copyFile,
  exists: native.exists,
  mkdir: native.mkdir,
  remove: native.remove,
  stat: native.stat,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: native.openUrl }));

import {
  finishVideoImport,
  normalizeHttpUrl,
  openAttachment,
  pickMediaAttachment,
  prepareVideoImport,
  prepareVideoImportFromPath,
  resolveMediaUrl,
} from "../src/services/media";
import type { Attachment } from "../src/domain/types";

const BLOB_HASH = "a".repeat(64);

beforeEach(() => {
  native.isTauri = false;
  vi.clearAllMocks();
  native.invoke.mockImplementation(
    (command: string, payload?: { relativePath?: string }) => {
      if (command !== "ingest_media_blob") {
        return Promise.resolve(
          command === "stage_media_file"
            ? { byteSize: 4096, fileName: "37.mp4" }
            : undefined,
        );
      }
      const extension = payload?.relativePath?.split(".").pop() ?? "jpg";
      return Promise.resolve({
        blobHash: BLOB_HASH,
        relativePath: `media/blobs/sha256/aa/${BLOB_HASH}.${extension}`,
        mimeType: extension === "jpg" ? "image/jpeg" : "video/mp4",
        fileExtension: extension,
        byteSize: extension === "jpg" ? 2048 : 4096,
      });
    },
  );
});

describe("attachment URL validation", () => {
  it("normalizes http and https URLs", () => {
    expect(normalizeHttpUrl(" https://example.com/technique ")).toBe(
      "https://example.com/technique",
    );
    expect(normalizeHttpUrl("http://localhost:3000/video")).toBe(
      "http://localhost:3000/video",
    );
  });

  it.each(["javascript:alert(1)", "file:///tmp/video.mov", "not a url"])(
    "rejects unsafe or invalid URL %s",
    (value) => expect(() => normalizeHttpUrl(value)).toThrow(),
  );

  it("opens a normalized link with the system opener", async () => {
    await openAttachment({
      id: "link-1",
      ownerType: "position",
      ownerId: "position-1",
      kind: "link",
      title: "Reference",
      value: " https://example.com/reference ",
    });
    expect(native.openUrl).toHaveBeenCalledWith("https://example.com/reference");
  });
});

describe("imported media", () => {
  const image: Attachment = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    ownerType: "position",
    ownerId: "position-1",
    kind: "image",
    title: "Armbar",
    value: "media/550e8400-e29b-41d4-a716-446655440000.jpg",
  };

  it("accepts only an app-owned UUID path with an extension matching its kind", async () => {
    await expect(resolveMediaUrl(image)).resolves.toBe(image.value);
    await expect(
      resolveMediaUrl({ ...image, value: "../outside.jpg" }),
    ).rejects.toThrow("Invalid imported media path");
    await expect(
      resolveMediaUrl({ ...image, value: image.value.replace(".jpg", ".mp4") }),
    ).rejects.toThrow("Invalid imported media path");
    await expect(
      resolveMediaUrl({ ...image, value: "media/not-a-uuid.jpg" }),
    ).rejects.toThrow("Invalid imported media path");
  });

  it("uses the loopback preview server for Android media", async () => {
    native.isTauri = true;
    const userAgent = vi
      .spyOn(navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Linux; Android 16)");
    native.invoke.mockResolvedValue("http://127.0.0.1:43210/media/token/path");

    await expect(resolveMediaUrl(image)).resolves.toBe(
      "http://127.0.0.1:43210/media/token/path",
    );
    expect(native.invoke).toHaveBeenCalledWith("resolve_media_preview_url", {
      relativePath: image.value,
    });
    expect(native.convertFileSrc).not.toHaveBeenCalled();
    userAgent.mockRestore();
  });

  it("validates and copies a selected image into app data", async () => {
    native.isTauri = true;
    native.open.mockResolvedValue("/tmp/Armbar.JPG");
    native.extname.mockResolvedValue(".JPG");
    native.basename.mockResolvedValue("Armbar.JPG");
    native.stat.mockResolvedValue({ isFile: true, size: 2048 });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(image.id);

    await expect(
      pickMediaAttachment("position", "position-1", "image"),
    ).resolves.toEqual({
      ...image,
      value: `media/blobs/sha256/aa/${BLOB_HASH}.jpg`,
      blobHash: BLOB_HASH,
      mimeType: "image/jpeg",
      fileExtension: "jpg",
      byteSize: 2048,
    });
    expect(native.open).toHaveBeenCalledWith(
      expect.objectContaining({ fileAccessMode: "copy" }),
    );
    expect(native.mkdir).toHaveBeenCalledWith("media", {
      baseDir: "AppData",
      recursive: true,
    });
    expect(native.copyFile).toHaveBeenCalledWith("/tmp/Armbar.JPG", image.value, {
      toPathBaseDir: "AppData",
    });
    expect(native.invoke).toHaveBeenCalledWith("ingest_media_blob", {
      databaseUrl: "sqlite:rollmap.db",
      relativePath: image.value,
    });
  });

  it("rejects an oversized image before copying it", async () => {
    native.isTauri = true;
    native.open.mockResolvedValue("/tmp/large.jpg");
    native.basename.mockResolvedValue("large.jpg");
    native.stat.mockResolvedValue({ isFile: true, size: 100 * 1024 * 1024 + 1 });

    await expect(pickMediaAttachment("position", "position-1", "image")).rejects.toThrow(
      "Image exceeds 100 MB",
    );
    expect(native.copyFile).not.toHaveBeenCalled();
  });

  it("rejects video formats unsupported by the native processor", async () => {
    native.isTauri = true;
    native.open.mockResolvedValue("/tmp/roll.webm");
    native.basename.mockResolvedValue("roll.webm");

    await expect(
      prepareVideoImport("technique", "technique-1"),
    ).rejects.toThrow("Unsupported video file type");
    expect(native.copyFile).not.toHaveBeenCalled();
  });

  it("stages a video inside its database media directory for preview", async () => {
    native.isTauri = true;
    native.open.mockResolvedValue("/tmp/Roll.mov");
    native.extname.mockResolvedValue(".mov");
    native.basename.mockResolvedValue("Roll.mov");
    native.stat.mockResolvedValue({ isFile: true, size: 4096 });
    native.appDataDir.mockResolvedValue("/app-data");
    native.join.mockResolvedValue(
      "/app-data/media/550e8400-e29b-41d4-a716-446655440001/staging/550e8400-e29b-41d4-a716-446655440000.mov",
    );
    native.convertFileSrc.mockReturnValue("asset://video-preview");
    vi.spyOn(crypto, "randomUUID").mockReturnValue(image.id);

    const draft = await prepareVideoImport(
      "position",
      "position-1",
      "media/550e8400-e29b-41d4-a716-446655440001",
    );
    expect(draft).toMatchObject({
      id: image.id,
      title: "Roll",
      sourceRelativePath:
        "media/550e8400-e29b-41d4-a716-446655440001/staging/550e8400-e29b-41d4-a716-446655440000.mov",
      previewUrl: "asset://video-preview",
    });
    expect(native.copyFile).toHaveBeenCalledWith(
      "/tmp/Roll.mov",
      draft?.sourceRelativePath,
      { toPathBaseDir: "AppData" },
    );
  });

  it("stages a dropped macOS video path without opening the file picker", async () => {
    native.isTauri = true;
    native.basename.mockResolvedValue("Mounted roll.MOV");
    native.stat.mockResolvedValue({ isFile: true, size: 8192 });
    native.appDataDir.mockResolvedValue("/app-data");
    native.join.mockResolvedValue(
      "/app-data/media/staging/550e8400-e29b-41d4-a716-446655440000.mov",
    );
    native.convertFileSrc.mockReturnValue("asset://dropped-video-preview");
    vi.spyOn(crypto, "randomUUID").mockReturnValue(image.id);

    const draft = await prepareVideoImportFromPath(
      "technique",
      "technique-1",
      "/Users/coach/Desktop/Mounted roll.MOV",
    );

    expect(draft).toMatchObject({
      id: image.id,
      ownerType: "technique",
      ownerId: "technique-1",
      title: "Mounted roll",
      sourceRelativePath: `media/staging/${image.id}.mov`,
      previewUrl: "asset://dropped-video-preview",
    });
    expect(native.open).not.toHaveBeenCalled();
    expect(native.stat).toHaveBeenCalledWith(
      "/Users/coach/Desktop/Mounted roll.MOV",
    );
    expect(native.copyFile).toHaveBeenCalledWith(
      "/Users/coach/Desktop/Mounted roll.MOV",
      `media/staging/${image.id}.mov`,
      { toPathBaseDir: "AppData" },
    );
  });

  it("streams an Android content URI into app data before previewing it", async () => {
    native.isTauri = true;
    native.open.mockResolvedValue("content://media/external/video/media/37");
    native.basename.mockResolvedValue("37.mp4");
    native.appDataDir.mockResolvedValue("/app-data");
    native.join.mockResolvedValue(
      "/app-data/media/staging/550e8400-e29b-41d4-a716-446655440000.mp4",
    );
    native.convertFileSrc.mockReturnValue("asset://video-preview");
    vi.spyOn(crypto, "randomUUID").mockReturnValue(image.id);

    const draft = await prepareVideoImport("position", "position-1");

    expect(draft).toMatchObject({ title: "Imported video", previewUrl: "asset://video-preview" });
    expect(native.stat).not.toHaveBeenCalled();
    expect(native.copyFile).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledWith("stage_media_file", {
      sourceUri: "content://media/external/video/media/37",
      destinationRelativePath: `media/staging/${image.id}.mp4`,
      mediaKind: "video",
    });
  });

  it("processes a compact full video and removes its staged source", async () => {
    native.isTauri = true;
    native.exists.mockResolvedValue(true);
    const sourceRelativePath = `media/staging/${image.id}.mov`;
    const draft = {
      id: image.id,
      ownerType: "position" as const,
      ownerId: "position-1",
      title: "Roll",
      mediaDirectory: "media",
      databaseUrl: "sqlite:rollmap.db",
      sourceRelativePath,
      previewUrl: "asset://video-preview",
    };

    await expect(
      finishVideoImport(draft, {
        quality: "compact",
        startSeconds: null,
        endSeconds: null,
      }),
    ).resolves.toMatchObject({
      kind: "video",
      value: `media/blobs/sha256/aa/${BLOB_HASH}.m4v`,
      blobHash: BLOB_HASH,
    });
    expect(native.invoke).toHaveBeenCalledWith("process_video", {
      operationId: image.id,
      inputRelativePath: sourceRelativePath,
      outputRelativePath: `media/${image.id}.m4v`,
      quality: "compact",
      startSeconds: null,
      durationSeconds: null,
    });
    expect(native.remove).toHaveBeenCalledWith(sourceRelativePath, {
      baseDir: "AppData",
    });
  });

  it("converts clip endpoints into start and duration arguments", async () => {
    native.isTauri = true;
    native.exists.mockResolvedValue(false);
    const draft = {
      id: image.id,
      ownerType: "technique" as const,
      ownerId: "technique-1",
      title: "Sweep detail",
      mediaDirectory: "media",
      databaseUrl: "sqlite:rollmap.db",
      sourceRelativePath: `media/staging/${image.id}.mp4`,
      previewUrl: "asset://video-preview",
    };

    await finishVideoImport(draft, {
      quality: "balanced",
      startSeconds: 12.5,
      endSeconds: 27.75,
    });
    expect(native.invoke).toHaveBeenCalledWith(
      "process_video",
      expect.objectContaining({
        quality: "balanced",
        startSeconds: 12.5,
        durationSeconds: 15.25,
      }),
    );
  });
});