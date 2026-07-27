import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  eventHandler: undefined as ((event: { payload: unknown }) => void) | undefined,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: native.listen,
}));

import { startLibraryMediaDownload } from "../src/services/mediaTransfer";

describe("media transfer task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.eventHandler = undefined;
    native.listen.mockImplementation(
      async (_event: string, handler: (event: { payload: unknown }) => void) => {
        native.eventHandler = handler;
        return native.unlisten;
      },
    );
  });

  it("filters progress by transfer ID, cancels, and removes its listener", async () => {
    let finishDownload: (value: unknown) => void = () => {};
    native.invoke.mockImplementation((command: string) => {
      if (command === "cancel_media_transfer") {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        finishDownload = resolve;
      });
    });
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "55555555-5555-4555-8555-555555555555",
    );
    const onProgress = vi.fn();
    const task = await startLibraryMediaDownload(
      "22222222-2222-4222-8222-222222222222",
      onProgress,
    );
    const matchingProgress = {
      transferId: task.transferId,
      syncLibraryId: "22222222-2222-4222-8222-222222222222",
      filesTotal: 2,
      filesProcessed: 0,
      bytesTotal: 100,
      bytesCompleted: 40,
      currentBlobHash: "a".repeat(64),
    };

    native.eventHandler?.({
      payload: {
        ...matchingProgress,
        transferId: "66666666-6666-4666-8666-666666666666",
      },
    });
    native.eventHandler?.({ payload: matchingProgress });
    await expect(task.cancel()).resolves.toBe(true);
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(matchingProgress);
    expect(native.invoke).toHaveBeenCalledWith("cancel_media_transfer", {
      transferId: task.transferId,
    });

    const report = {
      transferId: task.transferId,
      syncLibraryId: matchingProgress.syncLibraryId,
      filesTotal: 2,
      filesDownloaded: 1,
      bytesTotal: 100,
      bytesCompleted: 40,
      failures: [],
      cancelled: true,
    };
    finishDownload(report);
    await expect(task.result).resolves.toEqual(report);
    expect(native.unlisten).toHaveBeenCalledOnce();
  });
});