import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  isTauri: false,
  dragHandler: null as null | ((event: { payload: unknown }) => void),
  onDragDropEvent: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => native.isTauri,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onDragDropEvent: native.onDragDropEvent }),
}));

import {
  isSupportedVideoDropPath,
  subscribeToMacOSVideoDrops,
} from "../src/services/videoDrop";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  native.isTauri = false;
  native.dragHandler = null;
  native.onDragDropEvent.mockImplementation(async (handler) => {
    native.dragHandler = handler;
    return native.unlisten;
  });
});

describe("macOS video drops", () => {
  it("recognizes only video formats supported by the native processor", () => {
    expect(isSupportedVideoDropPath("/Users/coach/Roll.MOV")).toBe(true);
    expect(isSupportedVideoDropPath("/Users/coach/Roll.m4v")).toBe(true);
    expect(isSupportedVideoDropPath("/Users/coach/Roll.webm")).toBe(false);
  });

  it("forwards native drag events only in the macOS Tauri runtime", async () => {
    native.isTauri = true;
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    const listener = vi.fn();

    await expect(subscribeToMacOSVideoDrops(listener)).resolves.toBe(
      native.unlisten,
    );
    const payload = {
      type: "drop" as const,
      paths: ["/Users/coach/Roll.mov"],
      position: { x: 100, y: 200 },
    };
    native.dragHandler?.({ payload });

    expect(listener).toHaveBeenCalledWith(payload);
  });

  it("does not register native drag events in the browser", async () => {
    await expect(subscribeToMacOSVideoDrops(vi.fn())).resolves.toBeNull();
    expect(native.onDragDropEvent).not.toHaveBeenCalled();
  });
});
