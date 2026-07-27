import { isTauri } from "@tauri-apps/api/core";
import { listTrustedPeers } from "../data/devicePairing";
import {
  listDiscoveredLanPeers,
  startLanSyncServer,
  stopLanSyncServer,
  syncWithDiscoveredLanPeer,
  type LanSyncReport,
} from "../data/lanSync";
import {
  recordSyncFailure,
  recordSyncStarted,
  recordSyncSuccess,
} from "./syncActivity";

const DISCOVERY_POLL_MS = 5_000;
export const AUTOMATIC_SYNC_RETRY_MS = 60_000;

interface AutomaticSyncObserver {
  onStart?: (deviceId: string) => void;
  onSuccess?: (report: LanSyncReport) => void;
  onFailure?: (deviceId: string, error: unknown) => void;
}

export async function runAutomaticSyncCycle(
  lastAttempts: Map<string, number>,
  now = Date.now(),
  observer: AutomaticSyncObserver = {},
): Promise<LanSyncReport[]> {
  const server = await startLanSyncServer();
  const [trustedPeers, discoveredPeers] = await Promise.all([
    listTrustedPeers(),
    listDiscoveredLanPeers(),
  ]);
  const compatiblePeers = new Map(
    discoveredPeers
      .filter((peer) => peer.protocolMajor === server.protocolMajor)
      .map((peer) => [peer.deviceId, peer]),
  );
  for (const deviceId of lastAttempts.keys()) {
    if (!compatiblePeers.has(deviceId)) {
      lastAttempts.delete(deviceId);
    }
  }

  const reports: LanSyncReport[] = [];
  for (const trustedPeer of trustedPeers) {
    if (trustedPeer.revoked) {
      continue;
    }
    const discoveredPeer = compatiblePeers.get(trustedPeer.deviceId);
    const lastAttempt = lastAttempts.get(trustedPeer.deviceId) ?? 0;
    if (!discoveredPeer || now - lastAttempt < AUTOMATIC_SYNC_RETRY_MS) {
      continue;
    }
    lastAttempts.set(trustedPeer.deviceId, now);
    observer.onStart?.(trustedPeer.deviceId);
    try {
      const report = await syncWithDiscoveredLanPeer(discoveredPeer);
      reports.push(report);
      observer.onSuccess?.(report);
    } catch (error) {
      observer.onFailure?.(trustedPeer.deviceId, error);
      // Discovery is unauthenticated; failed identity/network checks retry later.
    }
  }
  return reports;
}

interface ForegroundLanAutomationOptions {
  onSyncComplete: (reports: LanSyncReport[]) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

export function startForegroundLanAutomation({
  onSyncComplete,
  onError,
}: ForegroundLanAutomationOptions): () => void {
  if (!isTauri()) {
    return () => {};
  }
  const lastAttempts = new Map<string, number>();
  let stopped = false;
  let running = false;

  async function runCycle() {
    if (stopped || running || document.visibilityState !== "visible") {
      return;
    }
    running = true;
    try {
      const reports = await runAutomaticSyncCycle(lastAttempts, Date.now(), {
        onStart: (deviceId) => recordSyncStarted("automatic", deviceId),
        onSuccess: (report) => recordSyncSuccess([report], "automatic"),
        onFailure: (deviceId, error) =>
          recordSyncFailure(error, "automatic", deviceId),
      });
      if (!stopped && document.visibilityState === "visible" && reports.length > 0) {
        await onSyncComplete(reports);
      }
    } catch (error) {
      if (!stopped) {
        recordSyncFailure(error, "automatic", null);
        onError?.(error);
      }
    } finally {
      running = false;
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") {
      void runCycle();
      return;
    }
    lastAttempts.clear();
    void stopLanSyncServer().catch(() => {});
  }

  document.addEventListener("visibilitychange", handleVisibilityChange);
  const initialTimer = window.setTimeout(() => void runCycle(), 0);
  const pollTimer = window.setInterval(() => void runCycle(), DISCOVERY_POLL_MS);
  return () => {
    stopped = true;
    window.clearTimeout(initialTimer);
    window.clearInterval(pollTimer);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    void stopLanSyncServer().catch(() => {});
  };
}