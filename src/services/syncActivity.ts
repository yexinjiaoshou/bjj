import type { LanSyncReport, SyncOverview } from "../data/lanSync";

const STORAGE_KEY = "rollmap.sync.activity.v1";

export type SyncMode = "automatic" | "manual";
export type SyncPhase = "idle" | "syncing" | "success" | "partial" | "error";

export interface SyncActivity {
  phase: SyncPhase;
  mode: SyncMode | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  remoteDeviceId: string | null;
  libraryCount: number;
  successfulLibraries: number;
  pushedChanges: number;
  pulledChanges: number;
  pushedSnapshots: number;
  pulledSnapshots: number;
  catalogChanges: number;
  conflicts: number;
  failedLibraries: LanSyncReport["failedLibraries"];
  error: string | null;
}

export interface SyncPresentation {
  tone: "neutral" | "active" | "success" | "warning" | "error";
  label: string;
  detail: string;
}

export const emptySyncActivity: SyncActivity = {
  phase: "idle",
  mode: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  remoteDeviceId: null,
  libraryCount: 0,
  successfulLibraries: 0,
  pushedChanges: 0,
  pulledChanges: 0,
  pushedSnapshots: 0,
  pulledSnapshots: 0,
  catalogChanges: 0,
  conflicts: 0,
  failedLibraries: [],
  error: null,
};

const listeners = new Set<(activity: SyncActivity) => void>();

function readStoredActivity(): SyncActivity {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return emptySyncActivity;
    }
    const parsed = JSON.parse(stored) as Partial<SyncActivity>;
    const lastAttemptMs = parsed.lastAttemptAt
      ? Date.parse(parsed.lastAttemptAt)
      : Number.NaN;
    const staleSyncing =
      parsed.phase === "syncing" &&
      (!Number.isFinite(lastAttemptMs) || Date.now() - lastAttemptMs > 120_000);
    return {
      ...emptySyncActivity,
      ...parsed,
      phase: staleSyncing ? "idle" : parsed.phase ?? "idle",
      failedLibraries: Array.isArray(parsed.failedLibraries)
        ? parsed.failedLibraries
        : [],
    };
  } catch {
    return emptySyncActivity;
  }
}

function writeActivity(activity: SyncActivity) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(activity));
  } catch {
    // Sync remains functional when browser storage is unavailable.
  }
  for (const listener of listeners) {
    listener(activity);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function getSyncActivity() {
  return readStoredActivity();
}

export function subscribeSyncActivity(listener: (activity: SyncActivity) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function formatSyncTime(value: string | null) {
  if (!value) {
    return "Never";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function getSyncPresentation(
  activity: SyncActivity,
  overview: SyncOverview,
): SyncPresentation {
  if (activity.phase === "syncing") {
    return {
      tone: "active",
      label: "Syncing",
      detail: `${activity.mode === "automatic" ? "Automatic" : "Manual"} sync in progress`,
    };
  }
  if (activity.phase === "error") {
    return {
      tone: "error",
      label: "Needs attention",
      detail: activity.error ?? "The last sync attempt failed",
    };
  }
  if (activity.phase === "partial") {
    return {
      tone: "warning",
      label: "Partly synced",
      detail: `${activity.failedLibraries.length} database${activity.failedLibraries.length === 1 ? "" : "s"} failed`,
    };
  }
  if (overview.trustedPeerCount === 0) {
    return {
      tone: "neutral",
      label: "Not paired",
      detail: "No trusted devices",
    };
  }
  if (overview.pendingSnapshotLibraries > 0) {
    return {
      tone: "warning",
      label: "Snapshot waiting",
      detail: `${overview.pendingSnapshotLibraries} database${overview.pendingSnapshotLibraries === 1 ? "" : "s"} need a full sync`,
    };
  }
  if (overview.pendingChanges > 0) {
    return {
      tone: "warning",
      label: `${overview.pendingChanges} waiting`,
      detail: `${overview.pendingChanges} change${overview.pendingChanges === 1 ? "" : "s"} not confirmed by every device`,
    };
  }
  if (overview.missingMediaFiles > 0) {
    return {
      tone: "warning",
      label: "Media incomplete",
      detail: `${overview.missingMediaFiles} media file${overview.missingMediaFiles === 1 ? "" : "s"} missing on this device`,
    };
  }
  if (activity.lastSuccessAt) {
    return {
      tone: "success",
      label: "Synced",
      detail: `Last successful sync ${formatSyncTime(activity.lastSuccessAt)}`,
    };
  }
  return {
    tone: "neutral",
    label: "Ready",
    detail: "Paired and ready to sync",
  };
}

export function recordSyncStarted(mode: SyncMode, remoteDeviceId: string | null) {
  const current = readStoredActivity();
  writeActivity({
    ...current,
    phase: "syncing",
    mode,
    lastAttemptAt: new Date().toISOString(),
    remoteDeviceId,
    failedLibraries: [],
    error: null,
  });
}

export function recordSyncSuccess(reports: LanSyncReport[], mode: SyncMode) {
  if (reports.length === 0) {
    return;
  }
  const current = readStoredActivity();
  const failedLibraries = reports.flatMap((report) => report.failedLibraries);
  const successfulLibraries = reports.reduce(
    (total, report) => total + report.successfulLibraries,
    0,
  );
  writeActivity({
    phase:
      failedLibraries.length === 0
        ? "success"
        : successfulLibraries > 0
          ? "partial"
          : "error",
    mode,
    lastAttemptAt: new Date().toISOString(),
    lastSuccessAt:
      successfulLibraries > 0 ? new Date().toISOString() : current.lastSuccessAt,
    remoteDeviceId:
      reports.length === 1 ? reports[0].remoteDeviceId : null,
    libraryCount: reports.reduce((total, report) => total + report.libraryCount, 0),
    successfulLibraries,
    pushedChanges: reports.reduce((total, report) => total + report.pushedChanges, 0),
    pulledChanges: reports.reduce((total, report) => total + report.pulledChanges, 0),
    pushedSnapshots: reports.reduce(
      (total, report) => total + report.pushedSnapshots,
      0,
    ),
    pulledSnapshots: reports.reduce(
      (total, report) => total + report.pulledSnapshots,
      0,
    ),
    catalogChanges: reports.reduce(
      (total, report) => total + report.catalogChanges,
      0,
    ),
    conflicts: reports.reduce((total, report) => total + report.conflicts, 0),
    failedLibraries,
    error: failedLibraries.length > 0 ? "Some databases could not sync" : null,
  });
}

export function recordSyncFailure(
  error: unknown,
  mode: SyncMode,
  remoteDeviceId: string | null,
) {
  const current = readStoredActivity();
  writeActivity({
    ...current,
    phase: "error",
    mode,
    lastAttemptAt: new Date().toISOString(),
    remoteDeviceId,
    failedLibraries: [],
    error: errorMessage(error),
  });
}