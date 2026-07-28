import { invoke } from "@tauri-apps/api/core";

const BILIBILI_HOSTS = new Set([
  "b23.tv",
  "bilibili.com",
  "m.bilibili.com",
  "player.bilibili.com",
  "www.bilibili.com",
]);
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/i;
const BILIBILI_INSPECTION_TIMEOUT_MS = 15_000;

export interface BilibiliPage {
  page: number;
  cid: number;
  part: string;
  durationSeconds: number;
}

export interface BilibiliVideoInfo {
  bvid: string;
  title: string;
  owner: string;
  durationSeconds: number;
  selectedPage: number;
  startSeconds: number;
  pages: BilibiliPage[];
}

export interface BilibiliLinkTarget {
  bvid: string;
  page: number;
  startSeconds: number;
}

export function extractHttpUrl(value: string) {
  const match = value.trim().match(/https?:\/\/[^\s<>"']+/i);
  return (match?.[0] ?? value.trim()).replace(/[),.;!?，。；！？）】]+$/u, "");
}

export function isBilibiliUrl(value: string) {
  try {
    return BILIBILI_HOSTS.has(new URL(extractHttpUrl(value)).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function positiveInteger(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeSeconds(value: string | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

export function parseBilibiliLink(value: string): BilibiliLinkTarget | null {
  try {
    const url = new URL(extractHttpUrl(value));
    if (!BILIBILI_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }
    const pathBvid = url.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/i)?.[1];
    const queryBvid = url.searchParams.get("bvid");
    const bvid = pathBvid ?? queryBvid;
    if (!bvid || !BVID_PATTERN.test(bvid)) {
      return null;
    }
    return {
      bvid,
      page: positiveInteger(url.searchParams.get("p"), 1),
      startSeconds: nonNegativeSeconds(url.searchParams.get("t")),
    };
  } catch {
    return null;
  }
}

export function parseTimestamp(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return 0;
  }
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isSafeInteger(seconds)) {
      throw new Error("Start time is too large");
    }
    return seconds;
  }
  const parts = normalized.split(":");
  if (
    (parts.length !== 2 && parts.length !== 3) ||
    parts.some((part) => !/^\d+$/.test(part))
  ) {
    throw new Error("Use seconds, MM:SS, or HH:MM:SS");
  }
  const numbers = parts.map(Number);
  if (numbers.slice(1).some((part) => part >= 60)) {
    throw new Error("Minutes and seconds must be below 60");
  }
  const seconds = numbers.reduce((total, part) => total * 60 + part, 0);
  if (!Number.isSafeInteger(seconds)) {
    throw new Error("Start time is too large");
  }
  return seconds;
}

export function formatTimestamp(seconds: number) {
  const normalized = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const remainder = normalized % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

export function buildBilibiliUrl(target: BilibiliLinkTarget) {
  const url = new URL(`https://www.bilibili.com/video/${target.bvid}/`);
  url.searchParams.set("p", String(target.page));
  url.searchParams.set("t", String(Math.max(0, Math.floor(target.startSeconds))));
  return url.toString();
}

export function buildBilibiliPlayerUrl(target: BilibiliLinkTarget) {
  const url = new URL("https://player.bilibili.com/player.html");
  url.searchParams.set("bvid", target.bvid);
  url.searchParams.set("p", String(target.page));
  url.searchParams.set("t", String(Math.max(0, Math.floor(target.startSeconds))));
  url.searchParams.set("autoplay", "0");
  url.searchParams.set("danmaku", "0");
  url.searchParams.set("poster", "1");
  return url.toString();
}

export function describeBilibiliLink(value: string) {
  const target = parseBilibiliLink(value);
  return target
    ? `Bilibili · P${target.page} · ${formatTimestamp(target.startSeconds)}`
    : null;
}

export async function inspectBilibiliLink(value: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error("Bilibili took too long to respond. You can still save the link."),
      );
    }, BILIBILI_INSPECTION_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      invoke<BilibiliVideoInfo>("inspect_bilibili_link", {
        url: extractHttpUrl(value),
      }),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}