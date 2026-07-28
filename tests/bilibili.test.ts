import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));

import {
  buildBilibiliUrl,
  buildBilibiliPlayerUrl,
  describeBilibiliLink,
  extractHttpUrl,
  inspectBilibiliLink,
  parseBilibiliLink,
  parseTimestamp,
} from "../src/services/bilibili";

beforeEach(() => vi.clearAllMocks());

describe("Bilibili links", () => {
  it("extracts a short link from copied share text", () => {
    expect(extractHttpUrl("分享视频 https://b23.tv/AbCd12 打开哔哩哔哩")).toBe(
      "https://b23.tv/AbCd12",
    );
  });

  it("parses canonical and player links with page and time", () => {
    expect(
      parseBilibiliLink(
        "https://www.bilibili.com/video/BV1B7411m7LV/?p=3&t=83&spm_id_from=x",
      ),
    ).toEqual({ bvid: "BV1B7411m7LV", page: 3, startSeconds: 83 });
    expect(
      parseBilibiliLink(
        "https://player.bilibili.com/player.html?bvid=BV1B7411m7LV&p=2&t=9.8",
      ),
    ).toEqual({ bvid: "BV1B7411m7LV", page: 2, startSeconds: 9 });
  });

  it("accepts seconds and clock timestamps", () => {
    expect(parseTimestamp("83")).toBe(83);
    expect(parseTimestamp("1:23")).toBe(83);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(() => parseTimestamp("1:75")).toThrow();
    expect(() => parseTimestamp("9".repeat(400))).toThrow("Start time is too large");
  });

  it("builds and describes a clean exact-time URL", () => {
    const value = buildBilibiliUrl({
      bvid: "BV1B7411m7LV",
      page: 2,
      startSeconds: 83,
    });
    expect(value).toBe(
      "https://www.bilibili.com/video/BV1B7411m7LV/?p=2&t=83",
    );
    expect(describeBilibiliLink(value)).toBe("Bilibili · P2 · 1:23");
    expect(
      buildBilibiliPlayerUrl({
        bvid: "BV1B7411m7LV",
        page: 2,
        startSeconds: 83,
      }),
    ).toBe(
      "https://player.bilibili.com/player.html?bvid=BV1B7411m7LV&p=2&t=83&autoplay=0&danmaku=0&poster=1",
    );
  });

  it("passes only the extracted URL to the native inspector", async () => {
    native.invoke.mockResolvedValue({ bvid: "BV1B7411m7LV" });
    await inspectBilibiliLink("标题 https://b23.tv/AbCd12 复制打开");
    expect(native.invoke).toHaveBeenCalledWith("inspect_bilibili_link", {
      url: "https://b23.tv/AbCd12",
    });
  });

  it("stops waiting when the native inspector does not return", async () => {
    vi.useFakeTimers();
    native.invoke.mockReturnValue(new Promise(() => {}));
    const inspection = inspectBilibiliLink("https://b23.tv/AbCd12").then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error)),
    );

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(inspection).resolves.toBe(
      "Bilibili took too long to respond. You can still save the link.",
    );
    vi.useRealTimers();
  });
});