import { invoke, isTauri } from "@tauri-apps/api/core";

const LIBRARY_CATALOG_KEY = "rollmap.library-catalog.v1";
const BROWSER_DEFAULT_SYNC_LIBRARY_ID = "00000000-0000-4000-8000-000000000001";

export interface KnowledgeLibrary {
  id: string;
  syncLibraryId: string;
  name: string;
  databaseUrl: string;
  mediaDirectory: string;
  browserStorageKey: string;
}

export interface LibraryCatalog {
  libraries: KnowledgeLibrary[];
  activeLibraryId: string;
}

export const defaultLibrary: KnowledgeLibrary = {
  id: "default",
  syncLibraryId: BROWSER_DEFAULT_SYNC_LIBRARY_ID,
  name: "Default database",
  databaseUrl: "sqlite:rollmap.db",
  mediaDirectory: "media",
  browserStorageKey: "rollmap.graph.v1",
};

function normalizeKnowledgeLibrary(value: unknown): KnowledgeLibrary | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const library = value as Record<string, unknown>;
  if (!(
    typeof library.id === "string" &&
    typeof library.name === "string" &&
    typeof library.databaseUrl === "string" &&
    typeof library.mediaDirectory === "string" &&
    typeof library.browserStorageKey === "string"
  )) {
    return null;
  }
  return {
    id: library.id,
    syncLibraryId:
      typeof library.syncLibraryId === "string"
        ? library.syncLibraryId
        : library.id === defaultLibrary.id
          ? BROWSER_DEFAULT_SYNC_LIBRARY_ID
          : crypto.randomUUID(),
    name: library.name,
    databaseUrl: library.databaseUrl,
    mediaDirectory: library.mediaDirectory,
    browserStorageKey: library.browserStorageKey,
  };
}

function loadBrowserLibraryCatalog(): LibraryCatalog {
  try {
    const serialized = window.localStorage.getItem(LIBRARY_CATALOG_KEY);
    const parsed = serialized ? (JSON.parse(serialized) as Partial<LibraryCatalog>) : null;
    const customLibraries = Array.isArray(parsed?.libraries)
      ? parsed.libraries
          .map(normalizeKnowledgeLibrary)
          .filter(
            (library): library is KnowledgeLibrary =>
              library !== null && library.id !== defaultLibrary.id,
          )
      : [];
    const libraries = [defaultLibrary, ...customLibraries];
    const activeLibraryId = libraries.some(
      (library) => library.id === parsed?.activeLibraryId,
    )
      ? (parsed?.activeLibraryId as string)
      : defaultLibrary.id;
    const catalog = { libraries, activeLibraryId };
    window.localStorage.setItem(LIBRARY_CATALOG_KEY, JSON.stringify(catalog));
    return catalog;
  } catch {
    return { libraries: [defaultLibrary], activeLibraryId: defaultLibrary.id };
  }
}

export async function loadLibraryCatalog(): Promise<LibraryCatalog> {
  const legacyCatalog = loadBrowserLibraryCatalog();
  if (!isTauri()) {
    return legacyCatalog;
  }
  return invoke<LibraryCatalog>("load_library_catalog", { legacyCatalog });
}

export async function saveLibraryCatalog(catalog: LibraryCatalog): Promise<void> {
  if (isTauri()) {
    await invoke("save_library_catalog", { catalog });
    return;
  }
  window.localStorage.setItem(LIBRARY_CATALOG_KEY, JSON.stringify(catalog));
}

export function createLibraryDefinition(name: string): KnowledgeLibrary {
  const id = crypto.randomUUID();
  return {
    id,
    syncLibraryId: id,
    name: name.trim(),
    databaseUrl: `sqlite:rollmap-library-${id}.db`,
    mediaDirectory: `media/${id}`,
    browserStorageKey: `rollmap.graph.library.${id}`,
  };
}