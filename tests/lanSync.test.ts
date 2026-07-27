import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  isTauri: true,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  isTauri: () => native.isTauri,
}));

import {
  getLanSyncServerStatus,
  getSyncOverview,
  pairWithLanServer,
  startLanSyncServer,
  stopLanSyncServer,
  syncWithLanServer,
} from "../src/data/lanSync";
import type { PairingOffer } from "../src/data/devicePairing";

const offer: PairingOffer = {
  protocolMajor: 2,
  deviceId: "550e8400-e29b-41d4-a716-446655440000",
  displayName: "Training Mac",
  identityPublicKey: "public-key",
  fingerprint: "fingerprint",
  token: "token",
  expiresAtMs: 1_800_000_000_000,
  libraries: [
    {
      syncLibraryId: "f42d5827-37b3-4809-9971-e968bf993a83",
      name: "Default database",
    },
  ],
};

describe("native LAN sync facade", () => {
  beforeEach(() => {
    native.isTauri = true;
    native.invoke.mockReset();
    native.invoke.mockResolvedValue(undefined);
  });

  it("maps server lifecycle, pairing, and manual sync commands", async () => {
    await startLanSyncServer();
    await getLanSyncServerStatus();
    await getSyncOverview(offer.libraries[0].syncLibraryId);
    await pairWithLanServer(
      "http://192.168.1.10:43210",
      offer,
      "Pixel 7",
      [offer.libraries[0].syncLibraryId],
    );
    await syncWithLanServer(
      "http://192.168.1.10:43210",
      offer.deviceId,
    );
    await stopLanSyncServer();

    expect(native.invoke.mock.calls).toEqual([
      ["start_lan_sync_server"],
      ["get_lan_sync_server_status"],
      [
        "get_sync_overview",
        { activeSyncLibraryId: offer.libraries[0].syncLibraryId },
      ],
      [
        "pair_with_lan_server",
        {
          baseUrl: "http://192.168.1.10:43210",
          offer,
          peerDisplayName: "Pixel 7",
          syncLibraryIds: [offer.libraries[0].syncLibraryId],
        },
      ],
      [
        "sync_with_lan_server",
        {
          baseUrl: "http://192.168.1.10:43210",
          remoteDeviceId: offer.deviceId,
        },
      ],
      ["stop_lan_sync_server"],
    ]);
  });

  it("rejects LAN calls in the browser fallback", async () => {
    native.isTauri = false;

    await expect(startLanSyncServer()).rejects.toThrow(
      "LAN sync is available only in the native app",
    );
    expect(native.invoke).not.toHaveBeenCalled();
  });
});
