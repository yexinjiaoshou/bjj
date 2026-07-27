import { beforeEach, describe, expect, it, vi } from "vitest";

const pairing = vi.hoisted(() => ({
  listTrustedPeers: vi.fn(),
}));

const lan = vi.hoisted(() => ({
  listDiscoveredLanPeers: vi.fn(),
  startLanSyncServer: vi.fn(),
  stopLanSyncServer: vi.fn(),
  syncWithDiscoveredLanPeer: vi.fn(),
}));

vi.mock("../src/data/devicePairing", () => pairing);
vi.mock("../src/data/lanSync", () => lan);

import {
  AUTOMATIC_SYNC_RETRY_MS,
  runAutomaticSyncCycle,
} from "../src/services/automaticSync";

const firstDeviceId = "11111111-1111-4111-8111-111111111111";
const secondDeviceId = "22222222-2222-4222-8222-222222222222";

function trustedPeer(deviceId: string) {
  return {
    deviceId,
    displayName: deviceId === firstDeviceId ? "Mac" : "Phone",
    identityPublicKey: "public-key",
    fingerprint: "sha256:fingerprint",
    syncLibraryIds: ["33333333-3333-4333-8333-333333333333"],
    trustedAt: "2026-07-26T12:00:00Z",
    revoked: false,
    baseUrl: null,
  };
}

function discoveredPeer(deviceId: string) {
  return {
    deviceId,
    baseUrls: [`http://192.168.1.${deviceId === firstDeviceId ? "10" : "11"}:45123`],
    protocolMajor: 2,
    appVersion: "0.1.0",
    pairingAvailable: true,
    lastSeenMs: Date.now(),
  };
}

function report(deviceId: string) {
  return {
    remoteDeviceId: deviceId,
    libraryCount: 1,
    successfulLibraries: 1,
    failedLibraries: [],
    catalogChanges: 0,
    pushedChanges: 0,
    pulledChanges: 1,
    pushedSnapshots: 0,
    pulledSnapshots: 0,
    conflicts: 0,
  };
}

describe("automatic LAN sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lan.startLanSyncServer.mockResolvedValue({
      port: 45123,
      baseUrls: ["http://192.168.1.20:45123"],
      protocolMajor: 2,
      transportSecurity: "testOnlyHttpSignedSession",
    });
    lan.stopLanSyncServer.mockResolvedValue(true);
  });

  it("syncs only discovered trusted peers and throttles repeated attempts", async () => {
    const untrustedDeviceId = "44444444-4444-4444-8444-444444444444";
    const firstDiscovered = discoveredPeer(firstDeviceId);
    pairing.listTrustedPeers.mockResolvedValue([trustedPeer(firstDeviceId)]);
    lan.listDiscoveredLanPeers.mockResolvedValue([
      firstDiscovered,
      discoveredPeer(untrustedDeviceId),
    ]);
    lan.syncWithDiscoveredLanPeer.mockResolvedValue(report(firstDeviceId));
    const attempts = new Map<string, number>();

    const firstReports = await runAutomaticSyncCycle(attempts, 100_000);
    const throttledReports = await runAutomaticSyncCycle(attempts, 100_001);

    expect(firstReports).toEqual([report(firstDeviceId)]);
    expect(throttledReports).toEqual([]);
    expect(lan.syncWithDiscoveredLanPeer).toHaveBeenCalledTimes(1);
    expect(lan.syncWithDiscoveredLanPeer).toHaveBeenCalledWith(firstDiscovered);
  });

  it("continues with another trusted peer when one endpoint fails", async () => {
    pairing.listTrustedPeers.mockResolvedValue([
      trustedPeer(firstDeviceId),
      trustedPeer(secondDeviceId),
    ]);
    lan.listDiscoveredLanPeers.mockResolvedValue([
      discoveredPeer(firstDeviceId),
      discoveredPeer(secondDeviceId),
    ]);
    lan.syncWithDiscoveredLanPeer
      .mockRejectedValueOnce(new Error("identity mismatch"))
      .mockResolvedValueOnce(report(secondDeviceId));

    const reports = await runAutomaticSyncCycle(
      new Map(),
      200_000 + AUTOMATIC_SYNC_RETRY_MS,
    );

    expect(reports).toEqual([report(secondDeviceId)]);
    expect(lan.syncWithDiscoveredLanPeer).toHaveBeenCalledTimes(2);
  });
});