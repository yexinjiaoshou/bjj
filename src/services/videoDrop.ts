import { isTauri } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  type DragDropEvent,
} from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

const SUPPORTED_VIDEO_PATH = /\.(?:mp4|mov|m4v)$/i;

export function isSupportedVideoDropPath(path: string) {
  return SUPPORTED_VIDEO_PATH.test(path);
}

function isMacOSRuntime() {
  return /Macintosh|Mac OS X/i.test(navigator.userAgent);
}

export async function subscribeToMacOSVideoDrops(
  listener: (event: DragDropEvent) => void,
): Promise<UnlistenFn | null> {
  if (!isTauri() || !isMacOSRuntime()) {
    return null;
  }
  return getCurrentWindow().onDragDropEvent(({ payload }) => listener(payload));
}

export type { DragDropEvent as VideoDragDropEvent };
