import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pairing = vi.hoisted(() => ({
  createPairingOffer: vi.fn(),
  listTrustedPeers: vi.fn(),
  renameTrustedPeer: vi.fn(),
  revokeTrustedPeer: vi.fn(),
}));

const lan = vi.hoisted(() => ({
  emptySyncOverview: {
    trustedPeerCount: 0,
    pendingChanges: 0,
    pendingSnapshotLibraries: 0,
    missingMediaFiles: 0,
    missingMediaBytes: 0,
  },
  getLanSyncServerStatus: vi.fn(),
  listDiscoveredLanPeers: vi.fn(),
  pairWithLanServer: vi.fn(),
  startLanSyncServer: vi.fn(),
  stopLanSyncServer: vi.fn(),
  syncWithLanServer: vi.fn(),
}));

const mediaTransfer = vi.hoisted(() => ({
  startLibraryMediaDownload: vi.fn(),
}));

const media = vi.hoisted(() => ({
  collectMediaGarbage: vi.fn(),
}));

const pairingQr = vi.hoisted(() => ({
  canScanPairingQr: vi.fn(),
  scanPairingQr: vi.fn(),
}));

vi.mock("../src/data/devicePairing", () => pairing);
vi.mock("../src/data/lanSync", () => lan);
vi.mock("../src/services/media", () => media);
vi.mock("../src/services/mediaTransfer", () => mediaTransfer);
vi.mock("../src/services/pairingQr", () => pairingQr);

import { SyncDialog } from "../src/features/sync/SyncDialog";

const offer = {
  protocolMajor: 2,
  deviceId: "11111111-1111-4111-8111-111111111111",
  displayName: "MacBook",
  identityPublicKey: "host-public-key",
  fingerprint: "sha256:host-fingerprint-value",
  token: "one-time-token",
  expiresAtMs: Date.now() + 60_000,
  libraries: [
    {
      syncLibraryId: "22222222-2222-4222-8222-222222222222",
      name: "Competition",
    },
    {
      syncLibraryId: "33333333-3333-4333-8333-333333333333",
      name: "Half guard",
    },
  ],
};

const trustedPeer = {
  deviceId: offer.deviceId,
  displayName: offer.displayName,
  identityPublicKey: offer.identityPublicKey,
  fingerprint: offer.fingerprint,
  syncLibraryIds: offer.libraries.map((library) => library.syncLibraryId),
  trustedAt: "2026-07-26T12:00:00Z",
  revoked: false,
  baseUrl: "http://192.168.1.20:45123",
};

describe("sync dialog", () => {
  beforeEach(() => {
    pairing.createPairingOffer.mockResolvedValue(offer);
    pairing.listTrustedPeers.mockResolvedValue([]);
    pairing.renameTrustedPeer.mockResolvedValue(trustedPeer);
    pairing.revokeTrustedPeer.mockResolvedValue(true);
    lan.getLanSyncServerStatus.mockResolvedValue(null);
    lan.listDiscoveredLanPeers.mockResolvedValue([]);
    lan.pairWithLanServer.mockResolvedValue(trustedPeer);
    lan.startLanSyncServer.mockResolvedValue({
      port: 45123,
      baseUrls: [
        "http://127.0.0.1:45123",
        "http://192.168.1.10:45123",
      ],
      protocolMajor: 2,
      transportSecurity: "testOnlyHttpSignedSession",
    });
    lan.stopLanSyncServer.mockResolvedValue(true);
    lan.syncWithLanServer.mockResolvedValue({
      remoteDeviceId: trustedPeer.deviceId,
      libraryCount: 2,
      successfulLibraries: 2,
      failedLibraries: [],
      catalogChanges: 0,
      pushedChanges: 3,
      pulledChanges: 4,
      pushedSnapshots: 0,
      pulledSnapshots: 0,
      conflicts: 0,
    });
    mediaTransfer.startLibraryMediaDownload.mockResolvedValue({
      transferId: "55555555-5555-4555-8555-555555555555",
      cancel: vi.fn().mockResolvedValue(true),
      result: Promise.resolve({
        transferId: "55555555-5555-4555-8555-555555555555",
        syncLibraryId: offer.libraries[0].syncLibraryId,
        filesTotal: 2,
        filesDownloaded: 2,
        bytesTotal: 4096,
        bytesCompleted: 4096,
        failures: [],
        cancelled: false,
      }),
    });
    media.collectMediaGarbage.mockResolvedValue({
      dryRun: true,
      librariesScanned: 2,
      referencedBlobs: 3,
      reclaimableFiles: 0,
      reclaimablePartialFiles: 0,
      reclaimableBytes: 0,
      staleRecords: 0,
      removedFiles: 0,
      removedPartialFiles: 0,
      removedBytes: 0,
      removedRecords: 0,
    });
    pairingQr.canScanPairingQr.mockReturnValue(false);
    pairingQr.scanPairingQr.mockResolvedValue(null);
  });

  it("starts a server and creates a payload with the LAN address", async () => {
    const user = userEvent.setup();
    render(
      <SyncDialog
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        onSyncComplete={vi.fn()}
        activeLibraryName="Competition"
        activeSyncLibraryId={offer.libraries[0].syncLibraryId}
        onMediaDownloadComplete={vi.fn()}
      />,
    );

    const hostTab = screen.getByRole("tab", { name: "Host" });
    await waitFor(() => expect(hostTab).toBeEnabled());
    await user.click(hostTab);
    await user.click(screen.getByRole("button", { name: "Start server" }));
    await user.click(
      await screen.findByRole("button", { name: "Create fresh pairing payload" }),
    );

    const payload = JSON.parse(
      (screen.getByLabelText("Pairing payload") as HTMLTextAreaElement).value,
    );
    expect(pairing.createPairingOffer).toHaveBeenCalledWith("My Rollmap");
    expect(payload).toEqual({
      baseUrl: "http://192.168.1.10:45123",
      offer,
    });
    expect(
      screen.getByRole("img", { name: "Pairing QR code" }),
    ).toBeInTheDocument();
  });

  it("explains last success, waiting changes, and missing media", async () => {
    render(
      <SyncDialog
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        onSyncComplete={vi.fn()}
        activeLibraryName="Competition"
        activeSyncLibraryId={offer.libraries[0].syncLibraryId}
        syncActivity={{
          phase: "success",
          mode: "automatic",
          lastAttemptAt: "2026-07-26T12:00:00.000Z",
          lastSuccessAt: "2026-07-26T12:00:00.000Z",
          remoteDeviceId: trustedPeer.deviceId,
          libraryCount: 2,
          successfulLibraries: 2,
          pushedChanges: 3,
          pulledChanges: 4,
          pushedSnapshots: 0,
          pulledSnapshots: 0,
          catalogChanges: 0,
          conflicts: 0,
          failedLibraries: [],
          error: null,
        }}
        syncOverview={{
          trustedPeerCount: 1,
          pendingChanges: 3,
          pendingSnapshotLibraries: 0,
          missingMediaFiles: 2,
          missingMediaBytes: 4096,
        }}
        onMediaDownloadComplete={vi.fn()}
      />,
    );

    expect(await screen.findByLabelText("Sync overview")).toHaveTextContent(
      "3 waiting",
    );
    expect(screen.getByLabelText("Sync overview")).toHaveTextContent("3 changes");
    expect(screen.getByLabelText("Sync overview")).toHaveTextContent("2 · 4.0 KB");
    expect(screen.getByLabelText("Sync overview")).toHaveTextContent(
      "automatic sync",
    );
  });

  it("loads a scanned Android QR code into the existing pairing flow", async () => {
    pairingQr.canScanPairingQr.mockReturnValue(true);
    pairingQr.scanPairingQr.mockResolvedValue(
      JSON.stringify({
        baseUrl: "http://192.168.1.10:45123",
        offer,
      }),
    );
    const user = userEvent.setup();
    render(
      <SyncDialog
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        onSyncComplete={vi.fn()}
        activeLibraryName="Competition"
        activeSyncLibraryId={offer.libraries[0].syncLibraryId}
        onMediaDownloadComplete={vi.fn()}
      />,
    );

    const joinTab = screen.getByRole("tab", { name: "Join" });
    await waitFor(() => expect(joinTab).toBeEnabled());
    await user.click(joinTab);
    await user.click(screen.getByRole("button", { name: "Scan QR" }));

    expect(pairingQr.scanPairingQr).toHaveBeenCalledOnce();
    expect(await screen.findByText("Pairing QR code scanned")).toBeInTheDocument();
    expect(screen.getAllByText("MacBook").length).toBeGreaterThan(0);
    expect(screen.getByRole("checkbox", { name: "Competition" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Half guard" })).toBeChecked();
  });

  it("pairs from pasted JSON with only the selected databases", async () => {
    const user = userEvent.setup();
    const onCatalogChanged = vi.fn();
    render(
      <SyncDialog
        onClose={vi.fn()}
        onCatalogChanged={onCatalogChanged}
        onSyncComplete={vi.fn()}
        activeLibraryName="Competition"
        activeSyncLibraryId={offer.libraries[0].syncLibraryId}
        onMediaDownloadComplete={vi.fn()}
      />,
    );

    const joinTab = screen.getByRole("tab", { name: "Join" });
    await waitFor(() => expect(joinTab).toBeEnabled());
    await user.click(joinTab);
    fireEvent.change(screen.getByLabelText("Pairing payload"), {
      target: {
        value: JSON.stringify({
          baseUrl: "http://192.168.1.10:45123",
          offer,
        }),
      },
    });
    await user.click(screen.getByRole("checkbox", { name: "Half guard" }));
    await user.click(screen.getByRole("button", { name: "Trust and pair" }));

    await waitFor(() =>
      expect(lan.pairWithLanServer).toHaveBeenCalledWith(
        "http://192.168.1.10:45123",
        offer,
        "My Rollmap",
        [offer.libraries[0].syncLibraryId],
      ),
    );
    expect(onCatalogChanged).toHaveBeenCalledOnce();
    expect(screen.getByText("MacBook is now trusted")).toBeInTheDocument();
  });

  it("syncs, renames, and revokes a trusted device", async () => {
    const user = userEvent.setup();
    const onSyncComplete = vi.fn();
    pairing.listTrustedPeers.mockResolvedValue([trustedPeer]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <SyncDialog
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        onSyncComplete={onSyncComplete}
        activeLibraryName="Competition"
        activeSyncLibraryId={offer.libraries[0].syncLibraryId}
        onMediaDownloadComplete={vi.fn()}
      />,
    );

    const endpoint = await screen.findByLabelText("LAN address for MacBook");
    expect(endpoint).toHaveValue(trustedPeer.baseUrl);
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() =>
      expect(lan.syncWithLanServer).toHaveBeenCalledWith(
        trustedPeer.baseUrl,
        trustedPeer.deviceId,
      ),
    );
    expect(onSyncComplete).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Rename MacBook" }));
    const renameInput = screen.getByLabelText("New name for MacBook");
    await user.clear(renameInput);
    await user.type(renameInput, "Training phone");
    await user.click(screen.getByRole("button", { name: "Save name for MacBook" }));
    await waitFor(() =>
      expect(pairing.renameTrustedPeer).toHaveBeenCalledWith(
        trustedPeer.deviceId,
        "Training phone",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Revoke MacBook" }));
    await waitFor(() =>
      expect(pairing.revokeTrustedPeer).toHaveBeenCalledWith(trustedPeer.deviceId),
    );
    expect(confirm).toHaveBeenCalledWith('Revoke access for "MacBook"?');
  });

  it("downloads all missing media for the active database", async () => {
    const user = userEvent.setup();
    const onMediaDownloadComplete = vi.fn();
    pairing.listTrustedPeers.mockResolvedValue([trustedPeer]);
    render(
      <SyncDialog
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        onSyncComplete={vi.fn()}
        activeLibraryName="Competition"
        activeSyncLibraryId={offer.libraries[0].syncLibraryId}
        onMediaDownloadComplete={onMediaDownloadComplete}
      />,
    );

    const downloadButton = await screen.findByRole("button", {
      name: "Download missing",
    });
    await user.click(downloadButton);

    await waitFor(() =>
      expect(mediaTransfer.startLibraryMediaDownload).toHaveBeenCalledWith(
        offer.libraries[0].syncLibraryId,
        expect.any(Function),
      ),
    );
    expect(onMediaDownloadComplete).toHaveBeenCalledOnce();
    expect(screen.getByText("Downloaded 2 of 2 media files")).toBeInTheDocument();
  });

  it("previews and confirms shared media cleanup", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    media.collectMediaGarbage
      .mockResolvedValueOnce({
        dryRun: true,
        librariesScanned: 2,
        referencedBlobs: 3,
        reclaimableFiles: 2,
        reclaimablePartialFiles: 1,
        reclaimableBytes: 2048,
        staleRecords: 2,
        removedFiles: 0,
        removedPartialFiles: 0,
        removedBytes: 0,
        removedRecords: 0,
      })
      .mockResolvedValueOnce({
        dryRun: false,
        librariesScanned: 2,
        referencedBlobs: 3,
        reclaimableFiles: 2,
        reclaimablePartialFiles: 1,
        reclaimableBytes: 2048,
        staleRecords: 2,
        removedFiles: 2,
        removedPartialFiles: 1,
        removedBytes: 2048,
        removedRecords: 2,
      });
    render(
      <SyncDialog
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        onSyncComplete={vi.fn()}
        activeLibraryName="Competition"
        activeSyncLibraryId={offer.libraries[0].syncLibraryId}
        onMediaDownloadComplete={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Scan storage" }));
    await waitFor(() => expect(media.collectMediaGarbage).toHaveBeenCalledWith(true));
    expect(screen.getByText("2 unused files · 2.0 KB · 2 stale records")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clean up" }));
    await waitFor(() => expect(media.collectMediaGarbage).toHaveBeenCalledWith(false));
    expect(confirm).toHaveBeenCalledWith(
      "Clean up 2 unused media files and 2 stale index records? Media used by any active library will be kept.",
    );
    expect(screen.getByText("Freed 2.0 KB from 2 unused media files")).toBeInTheDocument();
  });

  it("pauses a running media download", async () => {
    const user = userEvent.setup();
    pairing.listTrustedPeers.mockResolvedValue([trustedPeer]);
    let finishDownload: (report: unknown) => void = () => {};
    const result = new Promise((resolve) => {
      finishDownload = resolve;
    });
    const cancel = vi.fn(async () => {
      finishDownload({
        transferId: "55555555-5555-4555-8555-555555555555",
        syncLibraryId: offer.libraries[0].syncLibraryId,
        filesTotal: 2,
        filesDownloaded: 0,
        bytesTotal: 4096,
        bytesCompleted: 1024,
        failures: [],
        cancelled: true,
      });
      return true;
    });
    mediaTransfer.startLibraryMediaDownload.mockImplementationOnce(
      async (_syncLibraryId: string, onProgress: (progress: unknown) => void) => {
        onProgress({
          transferId: "55555555-5555-4555-8555-555555555555",
          syncLibraryId: offer.libraries[0].syncLibraryId,
          filesTotal: 2,
          filesProcessed: 0,
          bytesTotal: 4096,
          bytesCompleted: 1024,
          currentBlobHash: "a".repeat(64),
        });
        return {
          transferId: "55555555-5555-4555-8555-555555555555",
          cancel,
          result,
        };
      },
    );
    render(
      <SyncDialog
        onClose={vi.fn()}
        onCatalogChanged={vi.fn()}
        onSyncComplete={vi.fn()}
        activeLibraryName="Competition"
        activeSyncLibraryId={offer.libraries[0].syncLibraryId}
        onMediaDownloadComplete={vi.fn()}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Download missing" }),
    );
    await user.click(await screen.findByRole("button", { name: "Pause" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("Media download paused at 1.0 KB of 4.0 KB"),
    ).toBeInTheDocument();
  });
});