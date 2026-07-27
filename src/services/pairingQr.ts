import { invoke, isTauri } from "@tauri-apps/api/core";

export function canScanPairingQr() {
  return isTauri() && /Android/i.test(navigator.userAgent);
}

export async function scanPairingQr() {
  if (!canScanPairingQr()) {
    throw new Error("Pairing QR scanning is available on Android");
  }
  return invoke<string | null>("scan_pairing_qr");
}
