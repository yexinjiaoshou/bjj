import {
  Check,
  Clipboard,
  Download,
  LoaderCircle,
  Pencil,
  RefreshCw,
  ScanLine,
  Server,
  ServerOff,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import {
  createPairingOffer,
  listTrustedPeers,
  renameTrustedPeer,
  revokeTrustedPeer,
  type PairingOffer,
  type TrustedPeer,
} from "../../data/devicePairing";
import {
  getLanSyncServerStatus,
  listDiscoveredLanPeers,
  pairWithLanServer,
  startLanSyncServer,
  stopLanSyncServer,
  syncWithLanServer,
  type LanServerInfo,
  type LanSyncReport,
  type DiscoveredLanPeer,
  emptySyncOverview,
  type SyncOverview,
} from "../../data/lanSync";
import {
  collectMediaGarbage,
  type MediaGarbageCollectionReport,
} from "../../services/media";
import {
  startLibraryMediaDownload,
  type MediaTransferFailure,
  type MediaTransferProgress,
  type MediaTransferTask,
} from "../../services/mediaTransfer";
import { canScanPairingQr, scanPairingQr } from "../../services/pairingQr";
import {
  emptySyncActivity,
  formatSyncTime,
  getSyncPresentation,
  recordSyncFailure,
  recordSyncStarted,
  recordSyncSuccess,
  type SyncActivity,
} from "../../services/syncActivity";

interface SyncDialogProps {
  onClose: () => void;
  onCatalogChanged: () => Promise<void> | void;
  onSyncComplete: (report: LanSyncReport) => Promise<void> | void;
  activeLibraryName: string;
  activeSyncLibraryId: string;
  syncActivity?: SyncActivity;
  syncOverview?: SyncOverview;
  onMediaDownloadComplete: () => Promise<void> | void;
}

interface PairingPayload {
  baseUrl: string;
  offer: PairingOffer;
}

type SyncView = "devices" | "host" | "join";

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeLanUrl(value: string) {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:") {
    throw new Error("LAN address must use http:// during testing");
  }
  if (!parsed.hostname) {
    throw new Error("LAN address is missing a host");
  }
  return parsed.toString().replace(/\/$/, "");
}

function isPairingOffer(value: unknown): value is PairingOffer {
  if (!value || typeof value !== "object") {
    return false;
  }
  const offer = value as Record<string, unknown>;
  return (
    typeof offer.protocolMajor === "number" &&
    typeof offer.deviceId === "string" &&
    typeof offer.displayName === "string" &&
    typeof offer.identityPublicKey === "string" &&
    typeof offer.fingerprint === "string" &&
    typeof offer.token === "string" &&
    typeof offer.expiresAtMs === "number" &&
    Array.isArray(offer.libraries) &&
    offer.libraries.every(
      (library) =>
        library &&
        typeof library === "object" &&
        typeof (library as Record<string, unknown>).syncLibraryId === "string" &&
        typeof (library as Record<string, unknown>).name === "string",
    )
  );
}

function parsePairingPayload(value: string): PairingPayload {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Pairing payload must be a JSON object");
  }
  if (typeof parsed.baseUrl !== "string" || !isPairingOffer(parsed.offer)) {
    throw new Error("Pairing payload is missing its LAN address or offer");
  }
  return {
    baseUrl: normalizeLanUrl(parsed.baseUrl),
    offer: parsed.offer,
  };
}

function preferredServerUrl(server: LanServerInfo) {
  return (
    server.baseUrls.find((baseUrl) => {
      const hostname = new URL(baseUrl).hostname;
      return hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1";
    }) ?? server.baseUrls[0]
  );
}

function shortFingerprint(fingerprint: string) {
  return fingerprint.length > 23
    ? `${fingerprint.slice(0, 11)}...${fingerprint.slice(-8)}`
    : fingerprint;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

export function SyncDialog({
  onClose,
  onCatalogChanged,
  onSyncComplete,
  activeLibraryName,
  activeSyncLibraryId,
  syncActivity = emptySyncActivity,
  syncOverview = emptySyncOverview,
  onMediaDownloadComplete,
}: SyncDialogProps) {
  const [view, setView] = useState<SyncView>("devices");
  const [peers, setPeers] = useState<TrustedPeer[]>([]);
  const [discoveredPeers, setDiscoveredPeers] = useState<DiscoveredLanPeer[]>([]);
  const [server, setServer] = useState<LanServerInfo | null>(null);
  const [deviceName, setDeviceName] = useState("My Rollmap");
  const [pairingPayload, setPairingPayload] = useState("");
  const [joinText, setJoinText] = useState("");
  const [joinPayload, setJoinPayload] = useState<PairingPayload | null>(null);
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
  const [endpoints, setEndpoints] = useState<Record<string, string>>({});
  const [editingPeerId, setEditingPeerId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>("load");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncFailures, setSyncFailures] = useState<LanSyncReport["failedLibraries"]>([]);
  const [mediaProgress, setMediaProgress] = useState<MediaTransferProgress | null>(null);
  const [mediaFailures, setMediaFailures] = useState<MediaTransferFailure[]>([]);
  const [mediaGarbage, setMediaGarbage] =
    useState<MediaGarbageCollectionReport | null>(null);
  const mediaTask = useRef<MediaTransferTask | null>(null);
  const isBusy = pendingAction !== null;
  const activePeers = peers.filter((peer) => !peer.revoked);
  const onlinePeerIds = new Set(discoveredPeers.map((peer) => peer.deviceId));
  const qrScannerAvailable = canScanPairingQr();
  const syncPresentation = getSyncPresentation(syncActivity, syncOverview);
  const waitingSummary = syncOverview.pendingSnapshotLibraries > 0
    ? `${syncOverview.pendingSnapshotLibraries} snapshot${syncOverview.pendingSnapshotLibraries === 1 ? "" : "s"}`
    : syncOverview.pendingChanges > 0
      ? `${syncOverview.pendingChanges} change${syncOverview.pendingChanges === 1 ? "" : "s"}`
      : "None";
  const mediaSummary = syncOverview.missingMediaFiles > 0
    ? `${syncOverview.missingMediaFiles} · ${formatBytes(syncOverview.missingMediaBytes)}`
    : "Complete";
  const hasMediaGarbage = Boolean(
    mediaGarbage &&
      (mediaGarbage.reclaimableFiles > 0 || mediaGarbage.staleRecords > 0),
  );
  const displayedSyncFailures =
    syncFailures.length > 0 ? syncFailures : syncActivity.failedLibraries;
  const pairingPayloadFitsQr =
    pairingPayload.length > 0 &&
    new TextEncoder().encode(pairingPayload).byteLength <= 2_800;

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listTrustedPeers(),
      getLanSyncServerStatus(),
      listDiscoveredLanPeers(),
    ])
      .then(([trustedPeers, serverStatus, discovered]) => {
        if (cancelled) {
          return;
        }
        setPeers(trustedPeers);
        setServer(serverStatus);
        setDiscoveredPeers(discovered);
        setEndpoints(
          Object.fromEntries(
            trustedPeers.map((peer) => [
              peer.deviceId,
              discovered.find((item) => item.deviceId === peer.deviceId)?.baseUrls[0] ??
                peer.baseUrl ??
                "",
            ]),
          ),
        );
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(errorMessage(loadError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setPendingAction(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void listDiscoveredLanPeers()
        .then(setDiscoveredPeers)
        .catch(() => {});
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  async function reloadPeers() {
    const [trustedPeers, discovered] = await Promise.all([
      listTrustedPeers(),
      listDiscoveredLanPeers(),
    ]);
    setPeers(trustedPeers);
    setDiscoveredPeers(discovered);
    setEndpoints((current) => {
      const next = { ...current };
      for (const peer of trustedPeers) {
        const discoveredUrl = discovered.find(
          (item) => item.deviceId === peer.deviceId,
        )?.baseUrls[0];
        if (discoveredUrl) {
          next[peer.deviceId] = discoveredUrl;
        } else if (!next[peer.deviceId] && peer.baseUrl) {
          next[peer.deviceId] = peer.baseUrl;
        }
      }
      return next;
    });
  }

  async function handleReloadPeers() {
    beginAction("reload-peers");
    try {
      await reloadPeers();
      setNotice("Trusted devices refreshed");
    } catch (reloadError) {
      setError(errorMessage(reloadError));
    } finally {
      finishAction();
    }
  }

  function beginAction(action: string) {
    setPendingAction(action);
    setError(null);
    setNotice(null);
    setSyncFailures([]);
    setMediaFailures([]);
  }

  function finishAction() {
    setPendingAction(null);
  }

  async function handleStartServer() {
    beginAction("start-server");
    try {
      const serverInfo = await startLanSyncServer();
      setServer(serverInfo);
      setNotice(`LAN server started on port ${serverInfo.port}`);
    } catch (startError) {
      setError(errorMessage(startError));
    } finally {
      finishAction();
    }
  }

  async function handleStopServer() {
    beginAction("stop-server");
    try {
      await stopLanSyncServer();
      setServer(null);
      setPairingPayload("");
      setNotice("LAN server stopped");
    } catch (stopError) {
      setError(errorMessage(stopError));
    } finally {
      finishAction();
    }
  }

  async function handleCreatePairingPayload() {
    if (!server) {
      return;
    }
    beginAction("create-offer");
    try {
      const offer = await createPairingOffer(deviceName.trim() || "My Rollmap");
      const payload = {
        baseUrl: preferredServerUrl(server),
        offer,
      } satisfies PairingPayload;
      setPairingPayload(JSON.stringify(payload));
      setNotice("Fresh pairing payload created");
    } catch (offerError) {
      setError(errorMessage(offerError));
    } finally {
      finishAction();
    }
  }

  async function handleCopyPairingPayload() {
    beginAction("copy-offer");
    try {
      await navigator.clipboard.writeText(pairingPayload);
      setNotice("Pairing payload copied");
    } catch (copyError) {
      setError(errorMessage(copyError));
    } finally {
      finishAction();
    }
  }

  function handleJoinText(value: string) {
    setJoinText(value);
    setNotice(null);
    if (!value.trim()) {
      setJoinPayload(null);
      setSelectedLibraryIds([]);
      setError(null);
      return true;
    }
    try {
      const payload = parsePairingPayload(value);
      setJoinPayload(payload);
      setSelectedLibraryIds(
        payload.offer.libraries.map((library) => library.syncLibraryId),
      );
      setError(null);
      return true;
    } catch (parseError) {
      setJoinPayload(null);
      setSelectedLibraryIds([]);
      setError(errorMessage(parseError));
      return false;
    }
  }

  async function handleScanPairingQr() {
    beginAction("scan-qr");
    try {
      const value = await scanPairingQr();
      if (!value) {
        setNotice("QR scan cancelled");
        return;
      }
      if (handleJoinText(value)) {
        setNotice("Pairing QR code scanned");
      }
    } catch (scanError) {
      setError(errorMessage(scanError));
    } finally {
      finishAction();
    }
  }

  function toggleLibrary(syncLibraryId: string) {
    setSelectedLibraryIds((current) =>
      current.includes(syncLibraryId)
        ? current.filter((libraryId) => libraryId !== syncLibraryId)
        : [...current, syncLibraryId],
    );
  }

  async function handlePair() {
    if (!joinPayload || selectedLibraryIds.length === 0) {
      return;
    }
    beginAction("pair");
    try {
      const peer = await pairWithLanServer(
        joinPayload.baseUrl,
        joinPayload.offer,
        deviceName.trim() || "My Rollmap",
        selectedLibraryIds,
      );
      await Promise.all([reloadPeers(), onCatalogChanged()]);
      setEndpoints((current) => ({
        ...current,
        [peer.deviceId]: peer.baseUrl ?? joinPayload.baseUrl,
      }));
      setJoinText("");
      setJoinPayload(null);
      setSelectedLibraryIds([]);
      setView("devices");
      setNotice(`${peer.displayName} is now trusted`);
    } catch (pairError) {
      setError(errorMessage(pairError));
    } finally {
      finishAction();
    }
  }

  async function handleSync(peer: TrustedPeer) {
    beginAction(`sync:${peer.deviceId}`);
    recordSyncStarted("manual", peer.deviceId);
    let syncCompleted = false;
    try {
      const baseUrl = normalizeLanUrl(endpoints[peer.deviceId] ?? "");
      const report = await syncWithLanServer(baseUrl, peer.deviceId);
      syncCompleted = true;
      recordSyncSuccess([report], "manual");
      await Promise.all([reloadPeers(), onSyncComplete(report)]);
      setEndpoints((current) => ({ ...current, [peer.deviceId]: baseUrl }));
      const changes = report.pushedChanges + report.pulledChanges;
      const snapshots = report.pushedSnapshots + report.pulledSnapshots;
      setSyncFailures(report.failedLibraries);
      setNotice(
        `Synced ${report.successfulLibraries} of ${report.libraryCount} databases: ${changes} changes, ${snapshots} snapshots, ${report.catalogChanges} catalog updates`,
      );
    } catch (syncError) {
      if (!syncCompleted) {
        recordSyncFailure(syncError, "manual", peer.deviceId);
      }
      setError(errorMessage(syncError));
    } finally {
      finishAction();
    }
  }

  async function handleRename(peer: TrustedPeer) {
    const displayName = renameDraft.trim();
    if (!displayName) {
      return;
    }
    beginAction(`rename:${peer.deviceId}`);
    try {
      await renameTrustedPeer(peer.deviceId, displayName);
      await reloadPeers();
      setEditingPeerId(null);
      setRenameDraft("");
      setNotice("Device renamed");
    } catch (renameError) {
      setError(errorMessage(renameError));
    } finally {
      finishAction();
    }
  }

  async function handleRevoke(peer: TrustedPeer) {
    if (!window.confirm(`Revoke access for "${peer.displayName}"?`)) {
      return;
    }
    beginAction(`revoke:${peer.deviceId}`);
    try {
      await revokeTrustedPeer(peer.deviceId);
      await reloadPeers();
      setNotice(`${peer.displayName} was revoked`);
    } catch (revokeError) {
      setError(errorMessage(revokeError));
    } finally {
      finishAction();
    }
  }

  async function handleDownloadMedia() {
    beginAction("download-media");
    setMediaProgress(null);
    try {
      const task = await startLibraryMediaDownload(
        activeSyncLibraryId,
        setMediaProgress,
      );
      mediaTask.current = task;
      const report = await task.result;
      setMediaFailures(report.failures);
      await onMediaDownloadComplete();
      if (report.cancelled) {
        setNotice(
          `Media download paused at ${formatBytes(report.bytesCompleted)} of ${formatBytes(report.bytesTotal)}`,
        );
      } else if (report.filesTotal === 0) {
        setNotice("All media is available on this device");
      } else {
        setNotice(
          `Downloaded ${report.filesDownloaded} of ${report.filesTotal} media files${report.failures.length > 0 ? `; ${report.failures.length} unavailable` : ""}`,
        );
      }
    } catch (downloadError) {
      setError(errorMessage(downloadError));
    } finally {
      mediaTask.current = null;
      finishAction();
    }
  }

  async function handleCancelMedia() {
    const task = mediaTask.current;
    if (!task) {
      return;
    }
    setNotice("Pausing media download");
    try {
      await task.cancel();
    } catch (cancelError) {
      setError(errorMessage(cancelError));
    }
  }

  async function handleScanMediaGarbage() {
    beginAction("scan-media-garbage");
    try {
      const report = await collectMediaGarbage(true);
      setMediaGarbage(report);
      if (report.reclaimableFiles === 0 && report.staleRecords === 0) {
        setNotice("No unused media found");
      }
    } catch (scanError) {
      setError(errorMessage(scanError));
    } finally {
      finishAction();
    }
  }

  async function handleCollectMediaGarbage() {
    if (!mediaGarbage || !hasMediaGarbage) {
      return;
    }
    const fileSummary = `${mediaGarbage.reclaimableFiles} unused media file${mediaGarbage.reclaimableFiles === 1 ? "" : "s"}`;
    if (
      !window.confirm(
        `Clean up ${fileSummary} and ${mediaGarbage.staleRecords} stale index record${mediaGarbage.staleRecords === 1 ? "" : "s"}? Media used by any active library will be kept.`,
      )
    ) {
      return;
    }
    beginAction("collect-media-garbage");
    try {
      const report = await collectMediaGarbage(false);
      setMediaGarbage(null);
      if (report.removedFiles > 0) {
        setNotice(
          `Freed ${formatBytes(report.removedBytes)} from ${report.removedFiles} unused media file${report.removedFiles === 1 ? "" : "s"}`,
        );
      } else {
        setNotice(`Removed ${report.removedRecords} stale media index records`);
      }
    } catch (collectError) {
      setError(errorMessage(collectError));
    } finally {
      finishAction();
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={isBusy ? undefined : onClose}>
      <section
        className="entity-dialog sync-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>Local network</span>
            <h2 id="sync-dialog-title">Sync devices</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            title="Close"
            aria-label="Close sync"
            onClick={onClose}
            disabled={isBusy}
          >
            <X size={18} />
          </button>
        </header>

        <div className="sync-dialog__body">
          <div className="sync-tabs" role="tablist" aria-label="Sync setup">
            {(["devices", "host", "join"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={view === tab}
                className={view === tab ? "is-active" : ""}
                onClick={() => setView(tab)}
                disabled={isBusy}
              >
                {tab === "devices" ? "Devices" : tab === "host" ? "Host" : "Join"}
              </button>
            ))}
          </div>

          {view === "devices" && (
            <section className="sync-panel" aria-labelledby="trusted-devices-title">
              <div className="sync-panel__heading">
                <div>
                  <h3 id="trusted-devices-title">Trusted devices</h3>
                  <span>{activePeers.filter((peer) => onlinePeerIds.has(peer.deviceId)).length} online</span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  title="Refresh trusted devices"
                  aria-label="Refresh trusted devices"
                  onClick={() => void handleReloadPeers()}
                  disabled={isBusy}
                >
                  <RefreshCw
                    className={pendingAction === "reload-peers" ? "is-spinning" : undefined}
                    size={15}
                  />
                </button>
              </div>
              <div className="sync-overview" aria-label="Sync overview">
                <div>
                  <span>Status</span>
                  <strong className={`sync-tone--${syncPresentation.tone}`}>
                    {syncPresentation.label}
                  </strong>
                  <small>{syncPresentation.detail}</small>
                </div>
                <div>
                  <span>Last success</span>
                  <strong>{formatSyncTime(syncActivity.lastSuccessAt)}</strong>
                  <small>{syncActivity.mode ? `${syncActivity.mode} sync` : "No completed sync"}</small>
                </div>
                <div>
                  <span>Waiting</span>
                  <strong>{waitingSummary}</strong>
                  <small>Across trusted devices</small>
                </div>
                <div>
                  <span>Media</span>
                  <strong>{mediaSummary}</strong>
                  <small>{activeLibraryName}</small>
                </div>
              </div>
              {activePeers.length === 0 ? (
                <div className="sync-empty-state">
                  <Server size={20} />
                  <span>No trusted devices</span>
                </div>
              ) : (
                <div className="sync-peer-list">
                  {activePeers.map((peer) => (
                    <div className="sync-peer" key={peer.deviceId}>
                      <div className="sync-peer__identity">
                        {editingPeerId === peer.deviceId ? (
                          <div className="sync-rename-control">
                            <input
                              autoFocus
                              value={renameDraft}
                              aria-label={`New name for ${peer.displayName}`}
                              onChange={(event) => setRenameDraft(event.target.value)}
                            />
                            <button
                              type="button"
                              className="icon-button"
                              title="Save name"
                              aria-label={`Save name for ${peer.displayName}`}
                              onClick={() => void handleRename(peer)}
                              disabled={isBusy || !renameDraft.trim()}
                            >
                              <Check size={15} />
                            </button>
                          </div>
                        ) : (
                          <strong>{peer.displayName}</strong>
                        )}
                        <span>
                          {onlinePeerIds.has(peer.deviceId) ? "Online" : "Offline"}
                          <i aria-hidden="true">·</i>
                          {peer.syncLibraryIds.length} database{peer.syncLibraryIds.length === 1 ? "" : "s"}
                          <code title={peer.fingerprint}>{shortFingerprint(peer.fingerprint)}</code>
                        </span>
                      </div>
                      <div className="sync-peer__tools">
                        <button
                          type="button"
                          className="icon-button"
                          title="Rename device"
                          aria-label={`Rename ${peer.displayName}`}
                          onClick={() => {
                            setEditingPeerId(peer.deviceId);
                            setRenameDraft(peer.displayName);
                          }}
                          disabled={isBusy}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-button icon-button--danger"
                          title="Revoke device"
                          aria-label={`Revoke ${peer.displayName}`}
                          onClick={() => void handleRevoke(peer)}
                          disabled={isBusy}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <label className="field sync-peer__url">
                        <span>LAN address</span>
                        <input
                          type="url"
                          value={endpoints[peer.deviceId] ?? ""}
                          onChange={(event) =>
                            setEndpoints((current) => ({
                              ...current,
                              [peer.deviceId]: event.target.value,
                            }))
                          }
                          placeholder="http://192.168.1.20:45123"
                          aria-label={`LAN address for ${peer.displayName}`}
                          disabled={isBusy}
                        />
                      </label>
                      <button
                        type="button"
                        className="primary-button sync-now-button"
                        onClick={() => void handleSync(peer)}
                        disabled={isBusy || !(endpoints[peer.deviceId] ?? "").trim()}
                      >
                        {pendingAction === `sync:${peer.deviceId}` ? (
                          <LoaderCircle className="is-spinning" size={15} />
                        ) : (
                          <RefreshCw size={15} />
                        )}
                        {pendingAction === `sync:${peer.deviceId}` ? "Syncing" : "Sync now"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="sync-media-transfer">
                <div className="sync-media-transfer__summary">
                  <div>
                    <strong>{activeLibraryName}</strong>
                    <span>
                      {mediaProgress
                        ? `${mediaProgress.filesProcessed} of ${mediaProgress.filesTotal} files · ${formatBytes(mediaProgress.bytesCompleted)} of ${formatBytes(mediaProgress.bytesTotal)}`
                        : "Media on this device"}
                    </span>
                  </div>
                  {pendingAction === "download-media" ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleCancelMedia()}
                    >
                      <Square size={13} />
                      Pause
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleDownloadMedia()}
                      disabled={isBusy || activePeers.length === 0}
                    >
                      <Download size={14} />
                      Download missing
                    </button>
                  )}
                </div>
                {mediaProgress && (
                  <progress
                    aria-label="Media download progress"
                    max={Math.max(mediaProgress.bytesTotal, 1)}
                    value={Math.min(
                      mediaProgress.bytesCompleted,
                      Math.max(mediaProgress.bytesTotal, 1),
                    )}
                  />
                )}
                <div className="sync-media-transfer__summary sync-media-cleanup">
                  <div>
                    <strong>Shared media storage</strong>
                    <span>
                      {mediaGarbage
                        ? hasMediaGarbage
                          ? `${mediaGarbage.reclaimableFiles} unused file${mediaGarbage.reclaimableFiles === 1 ? "" : "s"} · ${formatBytes(mediaGarbage.reclaimableBytes)} · ${mediaGarbage.staleRecords} stale record${mediaGarbage.staleRecords === 1 ? "" : "s"}`
                          : `No unused files across ${mediaGarbage.librariesScanned} active librar${mediaGarbage.librariesScanned === 1 ? "y" : "ies"}`
                        : "Find files no longer used by any active library"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() =>
                      void (hasMediaGarbage
                        ? handleCollectMediaGarbage()
                        : handleScanMediaGarbage())
                    }
                    disabled={isBusy}
                  >
                    {pendingAction === "scan-media-garbage" ||
                    pendingAction === "collect-media-garbage" ? (
                      <LoaderCircle className="is-spinning" size={14} />
                    ) : hasMediaGarbage ? (
                      <Trash2 size={14} />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {pendingAction === "scan-media-garbage"
                      ? "Scanning"
                      : pendingAction === "collect-media-garbage"
                        ? "Cleaning"
                        : hasMediaGarbage
                          ? "Clean up"
                          : "Scan storage"}
                  </button>
                </div>
              </div>
            </section>
          )}

          {view === "host" && (
            <section className="sync-panel" aria-labelledby="host-sync-title">
              <div className="sync-panel__heading">
                <div>
                  <h3 id="host-sync-title">Host pairing</h3>
                  <span>{server ? `Running on port ${server.port}` : "Server stopped"}</span>
                </div>
                {server ? <Server size={17} /> : <ServerOff size={17} />}
              </div>
              <div className="sync-host-controls">
                <label className="field">
                  <span>This device name</span>
                  <input
                    value={deviceName}
                    onChange={(event) => setDeviceName(event.target.value)}
                    disabled={isBusy}
                  />
                </label>
                {server ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleStopServer()}
                    disabled={isBusy}
                  >
                    <ServerOff size={15} />
                    Stop server
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void handleStartServer()}
                    disabled={isBusy}
                  >
                    <Server size={15} />
                    Start server
                  </button>
                )}
              </div>
              {server && (
                <>
                  <div className="sync-addresses">
                    <span>Available addresses</span>
                    {server.baseUrls.map((baseUrl) => <code key={baseUrl}>{baseUrl}</code>)}
                  </div>
                  <button
                    type="button"
                    className="secondary-button sync-create-offer"
                    onClick={() => void handleCreatePairingPayload()}
                    disabled={isBusy}
                  >
                    {pendingAction === "create-offer" ? (
                      <LoaderCircle className="is-spinning" size={15} />
                    ) : (
                      <RefreshCw size={15} />
                    )}
                    Create fresh pairing payload
                  </button>
                </>
              )}
              {pairingPayload && (
                <div className="sync-pairing-code">
                  {pairingPayloadFitsQr ? (
                    <div
                      className="sync-pairing-qr"
                      role="img"
                      aria-label="Pairing QR code"
                    >
                      <QRCodeSVG
                        value={pairingPayload}
                        size={216}
                        level="L"
                        marginSize={2}
                      />
                    </div>
                  ) : (
                    <div className="sync-pairing-qr sync-pairing-qr--unavailable">
                      Pairing data is too large for one QR code. Copy the payload instead.
                    </div>
                  )}
                  <label className="field sync-payload-field">
                    <span>Pairing payload</span>
                    <textarea readOnly value={pairingPayload} />
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleCopyPairingPayload()}
                      disabled={isBusy}
                    >
                      <Clipboard size={15} />
                      Copy payload
                    </button>
                  </label>
                </div>
              )}
              <div className="sync-security-label">Test transport · HTTP with signed sessions</div>
            </section>
          )}

          {view === "join" && (
            <section className="sync-panel" aria-labelledby="join-sync-title">
              <div className="sync-panel__heading">
                <div>
                  <h3 id="join-sync-title">Join a device</h3>
                  <span>{joinPayload ? joinPayload.offer.displayName : "Paste a pairing payload"}</span>
                </div>
                <Clipboard size={17} />
              </div>
              {qrScannerAvailable && (
                <button
                  type="button"
                  className="secondary-button sync-scan-qr"
                  onClick={() => void handleScanPairingQr()}
                  disabled={isBusy}
                >
                  {pendingAction === "scan-qr" ? (
                    <LoaderCircle className="is-spinning" size={15} />
                  ) : (
                    <ScanLine size={15} />
                  )}
                  {pendingAction === "scan-qr" ? "Scanning" : "Scan QR"}
                </button>
              )}
              <label className="field sync-payload-field">
                <span>Pairing payload</span>
                <textarea
                  value={joinText}
                  onChange={(event) => handleJoinText(event.target.value)}
                  placeholder='{"baseUrl":"http://192.168.1.10:45123","offer":{...}}'
                  disabled={isBusy}
                />
              </label>
              {joinPayload && (
                <>
                  <div className="sync-join-identity">
                    <strong>{joinPayload.offer.displayName}</strong>
                    <code title={joinPayload.offer.fingerprint}>
                      {shortFingerprint(joinPayload.offer.fingerprint)}
                    </code>
                  </div>
                  <fieldset className="field sync-library-list">
                    <legend>Databases</legend>
                    {joinPayload.offer.libraries.map((library) => (
                      <label key={library.syncLibraryId}>
                        <input
                          type="checkbox"
                          checked={selectedLibraryIds.includes(library.syncLibraryId)}
                          onChange={() => toggleLibrary(library.syncLibraryId)}
                          disabled={isBusy}
                        />
                        <span>{library.name}</span>
                      </label>
                    ))}
                  </fieldset>
                  <div className="sync-join-actions">
                    <label className="field">
                      <span>This device name</span>
                      <input
                        value={deviceName}
                        onChange={(event) => setDeviceName(event.target.value)}
                        disabled={isBusy}
                      />
                    </label>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => void handlePair()}
                      disabled={
                        isBusy ||
                        selectedLibraryIds.length === 0 ||
                        joinPayload.offer.expiresAtMs <= Date.now()
                      }
                    >
                      {pendingAction === "pair" ? (
                        <LoaderCircle className="is-spinning" size={15} />
                      ) : (
                        <Check size={15} />
                      )}
                      {pendingAction === "pair" ? "Pairing" : "Trust and pair"}
                    </button>
                  </div>
                  {joinPayload.offer.expiresAtMs <= Date.now() && (
                    <p className="sync-inline-error">This pairing payload has expired</p>
                  )}
                </>
              )}
            </section>
          )}

          {(error || notice) && (
            <div
              className={`sync-feedback${error ? " sync-feedback--error" : ""}`}
              role={error ? "alert" : "status"}
            >
              {isBusy && <LoaderCircle className="is-spinning" size={14} />}
              <span>{error ?? notice}</span>
            </div>
          )}
          {displayedSyncFailures.length > 0 && (
            <div className="sync-failures" role="alert">
              <strong>{displayedSyncFailures.length} database sync failed</strong>
              {displayedSyncFailures.map((failure) => (
                <span key={failure.syncLibraryId}>
                  <code>{failure.syncLibraryId.slice(0, 8)}</code>
                  {failure.error}
                </span>
              ))}
            </div>
          )}
          {mediaFailures.length > 0 && (
            <div className="sync-failures" role="alert">
              <strong>{mediaFailures.length} media file unavailable</strong>
              {mediaFailures.map((failure) => (
                <span key={failure.blobHash}>
                  <code>{failure.blobHash.slice(0, 8)}</code>
                  {failure.error}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}