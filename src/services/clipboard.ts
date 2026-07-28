import { isTauri } from "@tauri-apps/api/core";
import { readText as readNativeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { extractHttpUrl } from "./bilibili";

export interface ClipboardLinkDraft {
  url: string;
  title: string;
}

function normalizeClipboardTitle(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:!?|·•\-–—，。；：！？]+|[\s,.;:!?|·•\-–—，。；：！？]+$/gu, "")
    .trim();
}

export function parseClipboardLink(value: string): ClipboardLinkDraft | null {
  const url = extractHttpUrl(value);
  try {
    const parsedUrl = new URL(url);
    if (!/^https?:$/.test(parsedUrl.protocol) || !parsedUrl.hostname) {
      return null;
    }
  } catch {
    return null;
  }

  const urlIndex = value.indexOf(url);
  const remainingText =
    urlIndex < 0
      ? ""
      : `${value.slice(0, urlIndex)} ${value.slice(urlIndex + url.length)}`;
  return {
    url,
    title: normalizeClipboardTitle(remainingText),
  };
}

export async function readClipboardText() {
  if (isTauri()) {
    return readNativeClipboardText();
  }
  if (!navigator.clipboard?.readText) {
    return null;
  }
  return navigator.clipboard.readText();
}
