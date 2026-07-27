import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  isTauri: false,
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: native.invoke,
  isTauri: () => native.isTauri,
}));

import {
  createLibraryDefinition,
  defaultLibrary,
  loadLibraryCatalog,
  saveLibraryCatalog,
} from "../src/data/libraryCatalog";

describe("knowledge database catalog", () => {
  beforeEach(() => {
    native.isTauri = false;
    window.localStorage.clear();
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses the existing Rollmap database as the permanent default", async () => {
    await expect(loadLibraryCatalog()).resolves.toEqual({
      libraries: [defaultLibrary],
      activeLibraryId: defaultLibrary.id,
    });
  });

  it("creates isolated database and media paths and restores the active library", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    const library = createLibraryDefinition("Competition game");
    expect(library).toMatchObject({
      syncLibraryId: "550e8400-e29b-41d4-a716-446655440000",
      name: "Competition game",
      databaseUrl:
        "sqlite:rollmap-library-550e8400-e29b-41d4-a716-446655440000.db",
      mediaDirectory: "media/550e8400-e29b-41d4-a716-446655440000",
    });

    await saveLibraryCatalog({
      libraries: [defaultLibrary, library],
      activeLibraryId: library.id,
    });
    await expect(loadLibraryCatalog()).resolves.toEqual({
      libraries: [defaultLibrary, library],
      activeLibraryId: library.id,
    });
  });

  it("passes the legacy browser catalog to the native catalog once", async () => {
    const legacyLibrary = {
      id: "legacy-library",
      name: "Imported database",
      databaseUrl: "sqlite:rollmap-library-legacy-library.db",
      mediaDirectory: "media/legacy-library",
      browserStorageKey: "rollmap.graph.library.legacy-library",
    };
    window.localStorage.setItem(
      "rollmap.library-catalog.v1",
      JSON.stringify({
        libraries: [legacyLibrary],
        activeLibraryId: legacyLibrary.id,
      }),
    );
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    const nativeCatalog = {
      libraries: [
        {
          ...defaultLibrary,
          syncLibraryId: "f42d5827-37b3-4809-9971-e968bf993a83",
        },
      ],
      activeLibraryId: defaultLibrary.id,
    };
    native.isTauri = true;
    native.invoke.mockResolvedValue(nativeCatalog);

    await expect(loadLibraryCatalog()).resolves.toEqual(nativeCatalog);
    expect(native.invoke).toHaveBeenCalledWith("load_library_catalog", {
      legacyCatalog: {
        libraries: [
          defaultLibrary,
          {
            ...legacyLibrary,
            syncLibraryId: "550e8400-e29b-41d4-a716-446655440000",
          },
        ],
        activeLibraryId: legacyLibrary.id,
      },
    });
  });

  it("persists Tauri catalog changes through the native command", async () => {
    native.isTauri = true;
    native.invoke.mockResolvedValue(undefined);
    const catalog = {
      libraries: [defaultLibrary],
      activeLibraryId: defaultLibrary.id,
    };

    await saveLibraryCatalog(catalog);

    expect(native.invoke).toHaveBeenCalledWith("save_library_catalog", { catalog });
    expect(window.localStorage).toHaveLength(0);
  });
});