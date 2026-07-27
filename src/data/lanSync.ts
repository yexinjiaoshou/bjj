import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  PairingOffer,
  TrustedPeer,
} from "./devicePairing";

export interface LanServerInfo {
  port: number;
  baseUrls: string[];
  protocolMajor: number;
  transportSecurity: "testOnlyHttpSignedSession";
}

export interface LanSyncReport {
  remoteDeviceId: string;
  libraryCount: number;
  successfulLibraries: number;
  failedLibraries: Array<{ syncLibraryId: string; error: string }>;
  catalogChanges: number;
  pushedChanges: number;
  pulledChanges: number;
  pushedSnapshots: number;
  pulledSnapshots: number;
  conflicts: number;
}

export interface DiscoveredLanPeer {
  deviceId: string;
  baseUrls: string[];
  protocolMajor: number;
  appVersion: string;
  pairingAvailable: boolean;
  lastSeenMs: number;
}

export interface SyncOverview {
  trustedPeerCount: number;
  pendingChanges: number;
  pendingSnapshotLibraries: number;
  missingMediaFiles: number;
  missingMediaBytes: number;
}

export const emptySyncOverview: SyncOverview = {
  trustedPeerCount: 0,
  pendingChanges: 0,
  pendingSnapshotLibraries: 0,
  missingMediaFiles: 0,
  missingMediaBytes: 0,
};

function requireNativeLanSync() {
  if (!isTauri()) {
    throw new Error("LAN sync is available only in the native app");
  }
}

export async function startLanSyncServer(): Promise<LanServerInfo> {
  requireNativeLanSync();
  return invoke<LanServerInfo>("start_lan_sync_server");
}

export async function getLanSyncServerStatus(): Promise<LanServerInfo | null> {
  requireNativeLanSync();
  return invoke<LanServerInfo | null>("get_lan_sync_server_status");
}

export async function getSyncOverview(
  activeSyncLibraryId: string,
): Promise<SyncOverview> {
  if (!isTauri()) {
    return emptySyncOverview;
  }
  return invoke<SyncOverview>("get_sync_overview", { activeSyncLibraryId });
}

export async function listDiscoveredLanPeers(): Promise<DiscoveredLanPeer[]> {
  requireNativeLanSync();
  return invoke<DiscoveredLanPeer[]>("list_discovered_lan_peers");
}

export async function stopLanSyncServer(): Promise<boolean> {
  requireNativeLanSync();
  return invoke<boolean>("stop_lan_sync_server");
}

export async function pairWithLanServer(
  baseUrl: string,
  offer: PairingOffer,
  peerDisplayName: string,
  syncLibraryIds: string[],
): Promise<TrustedPeer> {
  requireNativeLanSync();
  return invoke<TrustedPeer>("pair_with_lan_server", {
    baseUrl,
    offer,
    peerDisplayName,
    syncLibraryIds,
  });
}

export async function syncWithLanServer(
  baseUrl: string,
  remoteDeviceId: string,
): Promise<LanSyncReport> {
  requireNativeLanSync();
  return invoke<LanSyncReport>("sync_with_lan_server", {
    baseUrl,
    remoteDeviceId,
  });
}

export async function syncWithDiscoveredLanPeer(
  peer: DiscoveredLanPeer,
): Promise<LanSyncReport> {
  const failures: string[] = [];
  for (const baseUrl of peer.baseUrls) {
    try {
      return await syncWithLanServer(baseUrl, peer.deviceId);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    failures[failures.length - 1] ??
      `No usable LAN address was discovered for ${peer.deviceId}`,
  );
}
