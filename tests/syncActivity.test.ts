import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSyncActivity,
  recordSyncFailure,
  recordSyncStarted,
  recordSyncSuccess,
  subscribeSyncActivity,
} from "../src/services/syncActivity";

const report = {
  remoteDeviceId: "11111111-1111-4111-8111-111111111111",
  libraryCount: 2,
  successfulLibraries: 2,
  failedLibraries: [],
  catalogChanges: 1,
  pushedChanges: 3,
  pulledChanges: 4,
  pushedSnapshots: 0,
  pulledSnapshots: 1,
  conflicts: 0,
};

describe("sync activity", () => {
  beforeEach(() => window.localStorage.clear());

  it("persists a successful attempt and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSyncActivity(listener);

    recordSyncStarted("automatic", report.remoteDeviceId);
    expect(getSyncActivity().phase).toBe("syncing");
    recordSyncSuccess([report], "automatic");

    expect(getSyncActivity()).toMatchObject({
      phase: "success",
      mode: "automatic",
      lastSuccessAt: expect.any(String),
      successfulLibraries: 2,
      pushedChanges: 3,
      pulledChanges: 4,
      pulledSnapshots: 1,
      catalogChanges: 1,
    });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("retains the last success while explaining partial and transport failures", () => {
    recordSyncSuccess([report], "manual");
    const lastSuccessAt = getSyncActivity().lastSuccessAt;
    recordSyncSuccess(
      [
        {
          ...report,
          successfulLibraries: 1,
          failedLibraries: [
            { syncLibraryId: "library-2", error: "database unavailable" },
          ],
        },
      ],
      "manual",
    );
    expect(getSyncActivity()).toMatchObject({
      phase: "partial",
      failedLibraries: [
        { syncLibraryId: "library-2", error: "database unavailable" },
      ],
    });

    recordSyncFailure(new Error("peer offline"), "automatic", report.remoteDeviceId);
    expect(getSyncActivity()).toMatchObject({
      phase: "error",
      error: "peer offline",
      lastSuccessAt,
    });
  });
});