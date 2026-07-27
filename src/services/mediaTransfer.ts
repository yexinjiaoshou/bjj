import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface MediaTransferProgress {
  transferId: string;
  syncLibraryId: string;
  filesTotal: number;
  filesProcessed: number;
  bytesTotal: number;
  bytesCompleted: number;
  currentBlobHash: string | null;
}

export interface MediaTransferFailure {
  blobHash: string;
  error: string;
}

export interface MediaTransferReport {
  transferId: string;
  syncLibraryId: string;
  filesTotal: number;
  filesDownloaded: number;
  bytesTotal: number;
  bytesCompleted: number;
  failures: MediaTransferFailure[];
  cancelled: boolean;
}

export interface MediaTransferTask {
  transferId: string;
  result: Promise<MediaTransferReport>;
  cancel: () => Promise<boolean>;
}

export async function startLibraryMediaDownload(
  syncLibraryId: string,
  onProgress: (progress: MediaTransferProgress) => void,
): Promise<MediaTransferTask> {
  if (!isTauri()) {
    throw new Error("Media download is available only in the native app");
  }
  const transferId = crypto.randomUUID();
  const unlisten = await listen<MediaTransferProgress>(
    "media-transfer-progress",
    ({ payload }) => {
      if (payload.transferId === transferId) {
        onProgress(payload);
      }
    },
  );
  const result = Promise.resolve()
    .then(() =>
      invoke<MediaTransferReport>("download_library_media", {
        syncLibraryId,
        transferId,
      }),
    )
    .finally(unlisten);
  return {
    transferId,
    result,
    cancel: () => invoke<boolean>("cancel_media_transfer", { transferId }),
  };
}