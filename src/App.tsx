import {
  AlertTriangle,
  Database,
  Film,
  Focus,
  LayoutGrid,
  ListFilter,
  LoaderCircle,
  Map as MapIcon,
  Network,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Redo2,
  Search,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { XYPosition } from "@xyflow/react";
import "./App.css";
import {
  emptyGraph,
  getGraphRepository,
} from "./data/graphRepository";
import {
  createLibraryDefinition,
  defaultLibrary,
  loadLibraryCatalog,
  saveLibraryCatalog,
} from "./data/libraryCatalog";
import {
  emptySyncOverview,
  getSyncOverview,
  type SyncOverview,
} from "./data/lanSync";
import { sampleGraph } from "./domain/sampleData";
import type {
  GraphSelection,
  Attachment,
  KnowledgeGraph,
  Position,
  Technique,
} from "./domain/types";
import { DetailInspector } from "./features/editor/DetailInspector";
import {
  PositionEditorDialog,
  TechniqueEditorDialog,
  type TechniqueSaveRequest,
} from "./features/editor/EntityEditorDialog";
import { VideoImportDialog } from "./features/editor/VideoImportDialog";
import { GraphCanvas } from "./features/graph/GraphCanvas";
import {
  createAutomaticLayout,
  placeNewTargetPosition,
} from "./features/graph/layout";
import { LibrarySwitcher } from "./features/library/LibrarySwitcher";
import {
  filterGraph,
  type CategoryFilter,
  type DifficultyFilter,
  type GiModeFilter,
  type RoleFilter,
} from "./features/search/filterGraph";
import { LibrarySidebar } from "./features/search/LibrarySidebar";
import { SyncDialog } from "./features/sync/SyncDialog";
import {
  canCancelVideoProcessing,
  cancelVideoProcessing,
  deleteImportedMedia,
  downloadMediaAttachment,
  discardVideoImport,
  finishVideoImport,
  isVideoProcessingCancelled,
  openAttachment,
  pickMediaAttachment,
  prepareVideoImport,
  prepareVideoImportFromPath,
  type VideoImportDraft,
  type VideoImportOptions,
} from "./services/media";
import { startForegroundLanAutomation } from "./services/automaticSync";
import {
  emptySyncActivity,
  getSyncActivity,
  getSyncPresentation,
  subscribeSyncActivity,
  type SyncActivity,
} from "./services/syncActivity";
import {
  isSupportedVideoDropPath,
  subscribeToMacOSVideoDrops,
  type VideoDragDropEvent,
} from "./services/videoDrop";

type EditorState =
  | { type: "position"; entity: Position; isNew: boolean }
  | { type: "technique"; entity: Technique; isNew: boolean }
  | null;

type InspectorMode = "hidden" | "partial" | "full";
type MobileView = "browse" | "map" | "details";
type AndroidBackResult = "handled" | "exit";

interface GraphHistoryEntry {
  before: KnowledgeGraph;
  after: KnowledgeGraph;
}

interface LibraryGraphHistory {
  undo: GraphHistoryEntry[];
  redo: GraphHistoryEntry[];
}

const HISTORY_LIMIT = 100;

declare global {
  interface Window {
    __ROLLMAP_HANDLE_ANDROID_BACK__?: () => AndroidBackResult;
  }
}

function useMobileLayout() {
  const query = "(max-width: 600px)";
  const [isMobileLayout, setIsMobileLayout] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia?.(query);
    if (!mediaQuery) {
      return;
    }
    const update = () => setIsMobileLayout(mediaQuery.matches);
    update();
    mediaQuery.addEventListener("change", update);
    return () => mediaQuery.removeEventListener("change", update);
  }, []);

  return isMobileLayout;
}

function getErrorMessage(action: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return `${action}: ${detail}`;
}

function formatFilterLabel(value: string) {
  if (value === "nogi") {
    return "No-Gi";
  }
  return value.replace(/-/g, " ");
}

function cloneGraphSnapshot(graph: KnowledgeGraph) {
  return structuredClone(graph);
}

function graphSnapshotsEqual(left: KnowledgeGraph, right: KnowledgeGraph) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function historyCurrentGraph(history: LibraryGraphHistory) {
  const nextRedo = history.redo[history.redo.length - 1];
  if (nextRedo) {
    return nextRedo.before;
  }
  return history.undo[history.undo.length - 1]?.after;
}

function createPosition(index: number): Position {
  return {
    id: crypto.randomUUID(),
    name: "",
    aliases: [],
    description: "",
    category: "guard",
    role: "bottom",
    tags: [],
    x: 180 + (index % 3) * 260,
    y: 140 + (index % 4) * 150,
  };
}

function createTechnique(
  sourcePositionId: string,
  targetPositionId: string | null = null,
): Technique {
  return {
    id: crypto.randomUUID(),
    sourcePositionId,
    targetPositionId,
    name: "",
    description: "",
    giMode: "both",
    difficulty: "foundation",
    tags: [],
  };
}

function App() {
  const [libraryCatalog, setLibraryCatalog] = useState(() => ({
    libraries: [defaultLibrary],
    activeLibraryId: defaultLibrary.id,
  }));
  const [isCatalogLoading, setIsCatalogLoading] = useState(true);
  const [graph, setGraph] = useState<KnowledgeGraph>(emptyGraph);
  const graphRef = useRef<KnowledgeGraph>(emptyGraph);
  const [historyByLibrary, setHistoryByLibrary] = useState<
    Record<string, LibraryGraphHistory>
  >({});
  const [selection, setSelection] = useState<GraphSelection>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [role, setRole] = useState<RoleFilter>("all");
  const [giMode, setGiMode] = useState<GiModeFilter>("all");
  const [difficulty, setDifficulty] = useState<DifficultyFilter>("all");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [focusSelection, setFocusSelection] = useState(false);
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>("partial");
  const [mobileView, setMobileView] = useState<MobileView>("map");
  const [revealRequest, setRevealRequest] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingActions, setPendingActions] = useState(0);
  const [isArranging, setIsArranging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [emptyStateDismissed, setEmptyStateDismissed] = useState(false);
  const [layoutPreview, setLayoutPreview] = useState<Position[] | null>(null);
  const [videoImportDraft, setVideoImportDraft] = useState<VideoImportDraft | null>(
    null,
  );
  const [videoProcessingId, setVideoProcessingId] = useState<string | null>(null);
  const [isVideoDropActive, setIsVideoDropActive] = useState(false);
  const [isSyncDialogOpen, setIsSyncDialogOpen] = useState(false);
  const [syncActivity, setSyncActivity] = useState<SyncActivity>(
    () => getSyncActivity() ?? emptySyncActivity,
  );
  const [syncOverview, setSyncOverview] =
    useState<SyncOverview>(emptySyncOverview);
  const isMobileLayout = useMobileLayout();
  const activeLibrary =
    libraryCatalog.libraries.find(
      (library) => library.id === libraryCatalog.activeLibraryId,
    ) ?? defaultLibrary;
  const graphRepository = useMemo(
    () => getGraphRepository(activeLibrary),
    [activeLibrary],
  );
  const activeHistory = historyByLibrary[activeLibrary.id];
  const historyBlocked =
    isCatalogLoading ||
    isLoading ||
    isArranging ||
    pendingActions > 0 ||
    videoImportDraft !== null ||
    layoutPreview !== null ||
    editor !== null ||
    isSyncDialogOpen;
  const canUndo = !historyBlocked && (activeHistory?.undo.length ?? 0) > 0;
  const canRedo = !historyBlocked && (activeHistory?.redo.length ?? 0) > 0;
  const selectedDropPosition =
    selection?.type === "position"
      ? graph.positions.find((position) => position.id === selection.id)
      : undefined;
  const selectedDropTechnique =
    selection?.type === "technique"
      ? graph.techniques.find((technique) => technique.id === selection.id)
      : undefined;
  const videoDropOwner = selectedDropPosition
    ? {
        ownerType: "position" as const,
        ownerId: selectedDropPosition.id,
        label: selectedDropPosition.name || "Untitled position",
      }
    : selectedDropTechnique
      ? {
          ownerType: "technique" as const,
          ownerId: selectedDropTechnique.id,
          label: selectedDropTechnique.name || "Untitled transition",
        }
      : undefined;
  const syncPresentation = getSyncPresentation(syncActivity, syncOverview);

  useEffect(() => subscribeSyncActivity(setSyncActivity), []);

  useEffect(() => {
    let cancelled = false;

    async function loadCatalog() {
      try {
        const catalog = await loadLibraryCatalog();
        if (!cancelled) {
          setLibraryCatalog(catalog);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(getErrorMessage("Could not load the database catalog", error));
        }
      } finally {
        if (!cancelled) {
          setIsCatalogLoading(false);
        }
      }
    }

    void loadCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (isCatalogLoading) {
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    replaceGraph(emptyGraph);

    async function loadGraph() {
      try {
        const storedGraph = await graphRepository.loadGraph();
        if (!cancelled) {
          validateLibraryHistory(activeLibrary.id, storedGraph);
          replaceGraph(storedGraph);
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(getErrorMessage("Could not load the knowledge base", error));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadGraph();
    return () => {
      cancelled = true;
    };
  }, [graphRepository, isCatalogLoading]);

  useEffect(() => {
    if (isCatalogLoading || isLoading || pendingActions > 0) {
      return;
    }
    let cancelled = false;
    const loadOverview = () => {
      void getSyncOverview(activeLibrary.syncLibraryId)
        .then((overview) => {
          if (!cancelled) {
            setSyncOverview(overview);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setErrorMessage(getErrorMessage("Could not read sync status", error));
          }
        });
    };
    loadOverview();
    const timer = window.setInterval(loadOverview, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    activeLibrary.syncLibraryId,
    isCatalogLoading,
    isLoading,
    pendingActions,
  ]);

  useEffect(() => {
    if (isCatalogLoading) {
      return;
    }
    return startForegroundLanAutomation({
      onSyncComplete: refreshGraphAfterSync,
    });
  }, [isCatalogLoading]);

  const positionsToDisplay = layoutPreview ?? graph.positions;
  const visibleGraph = useMemo(
    () =>
      filterGraph(
        { ...graph, positions: positionsToDisplay },
        { category, role, giMode, difficulty, tag: activeTag },
      ),
    [activeTag, category, difficulty, giMode, graph, positionsToDisplay, role],
  );
  const hasActiveFilters =
    category !== "all" ||
    role !== "all" ||
    giMode !== "all" ||
    difficulty !== "all" ||
    activeTag !== null;

  function clearFilters() {
    setCategory("all");
    setRole("all");
    setGiMode("all");
    setDifficulty("all");
    setActiveTag(null);
  }

  function resetLibraryWorkspace() {
    setSelection(null);
    setEditor(null);
    setFocusSelection(false);
    setLayoutPreview(null);
    setQuery("");
    setMobileView("map");
    clearFilters();
  }

  function replaceGraph(nextGraph: KnowledgeGraph) {
    graphRef.current = nextGraph;
    setGraph(nextGraph);
  }

  function recordGraphHistory(
    libraryId: string,
    before: KnowledgeGraph,
    after: KnowledgeGraph,
  ) {
    if (graphSnapshotsEqual(before, after)) {
      return;
    }
    const entry = {
      before: cloneGraphSnapshot(before),
      after: cloneGraphSnapshot(after),
    };
    setHistoryByLibrary((current) => {
      const history = current[libraryId] ?? { undo: [], redo: [] };
      return {
        ...current,
        [libraryId]: {
          undo: [...history.undo, entry].slice(-HISTORY_LIMIT),
          redo: [],
        },
      };
    });
  }

  function commitGraphChange(
    before: KnowledgeGraph,
    after: KnowledgeGraph,
    libraryId = activeLibrary.id,
  ) {
    replaceGraph(after);
    recordGraphHistory(libraryId, before, after);
  }

  function clearLibraryHistory(libraryId: string) {
    setHistoryByLibrary((current) => {
      if (!current[libraryId]) {
        return current;
      }
      const next = { ...current };
      delete next[libraryId];
      return next;
    });
  }

  function validateLibraryHistory(
    libraryId: string,
    loadedGraph: KnowledgeGraph,
  ) {
    setHistoryByLibrary((current) => {
      const history = current[libraryId];
      const expectedGraph = history && historyCurrentGraph(history);
      if (!expectedGraph || graphSnapshotsEqual(expectedGraph, loadedGraph)) {
        return current;
      }
      const next = { ...current };
      delete next[libraryId];
      return next;
    });
  }

  function reconcileSelection(nextGraph: KnowledgeGraph) {
    setSelection((current) => {
      if (!current) {
        return null;
      }
      const stillExists =
        current.type === "position"
          ? nextGraph.positions.some((position) => position.id === current.id)
          : nextGraph.techniques.some((technique) => technique.id === current.id);
      return stillExists ? current : null;
    });
  }

  async function changeLibrary(libraryId: string) {
    if (
      libraryId === libraryCatalog.activeLibraryId ||
      pendingActions > 0 ||
      isArranging ||
      videoImportDraft !== null
    ) {
      return;
    }
    const nextCatalog = { ...libraryCatalog, activeLibraryId: libraryId };
    beginAction();
    try {
      await saveLibraryCatalog(nextCatalog);
      clearLibraryHistory(libraryId);
      resetLibraryWorkspace();
      setLibraryCatalog(nextCatalog);
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not switch databases", error));
    } finally {
      finishAction();
    }
  }

  async function createLibrary(name: string) {
    if (
      libraryCatalog.libraries.some(
        (library) => library.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setErrorMessage("Could not create the database: that name is already in use");
      return false;
    }

    const library = createLibraryDefinition(name);
    beginAction();
    try {
      await getGraphRepository(library).loadGraph();
      const nextCatalog = {
        libraries: [...libraryCatalog.libraries, library],
        activeLibraryId: library.id,
      };
      await saveLibraryCatalog(nextCatalog);
      resetLibraryWorkspace();
      setLibraryCatalog(nextCatalog);
      return true;
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not create the database", error));
      return false;
    } finally {
      finishAction();
    }
  }

  async function renameLibrary(libraryId: string, name: string) {
    if (
      libraryCatalog.libraries.some(
        (library) =>
          library.id !== libraryId &&
          library.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setErrorMessage("Could not rename the database: that name is already in use");
      return false;
    }
    const nextCatalog = {
      ...libraryCatalog,
      libraries: libraryCatalog.libraries.map((library) =>
        library.id === libraryId ? { ...library, name: name.trim() } : library,
      ),
    };
    beginAction();
    try {
      await saveLibraryCatalog(nextCatalog);
      setLibraryCatalog(nextCatalog);
      return true;
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not rename the database", error));
      return false;
    } finally {
      finishAction();
    }
  }

  async function deleteLibrary(libraryId: string) {
    if (libraryId === defaultLibrary.id) {
      return false;
    }
    const nextCatalog = {
      libraries: libraryCatalog.libraries.filter((library) => library.id !== libraryId),
      activeLibraryId:
        libraryCatalog.activeLibraryId === libraryId
          ? defaultLibrary.id
          : libraryCatalog.activeLibraryId,
    };
    beginAction();
    try {
      await saveLibraryCatalog(nextCatalog);
      resetLibraryWorkspace();
      setLibraryCatalog(nextCatalog);
      return true;
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not delete the database", error));
      return false;
    } finally {
      finishAction();
    }
  }

  async function refreshCatalogAfterPairing() {
    const catalog = await loadLibraryCatalog();
    setLibraryCatalog(catalog);
    const active =
      catalog.libraries.find((library) => library.id === catalog.activeLibraryId) ??
      defaultLibrary;
    setSyncOverview(await getSyncOverview(active.syncLibraryId));
  }

  async function refreshGraphAfterSync() {
    const catalog = await loadLibraryCatalog();
    const syncedLibrary =
      catalog.libraries.find((library) => library.id === catalog.activeLibraryId) ??
      defaultLibrary;
    const [syncedGraph, overview] = await Promise.all([
      getGraphRepository(syncedLibrary).loadGraph(),
      getSyncOverview(syncedLibrary.syncLibraryId),
    ]);
    setLibraryCatalog(catalog);
    setLayoutPreview(null);
    if (!graphSnapshotsEqual(graphRef.current, syncedGraph)) {
      clearLibraryHistory(syncedLibrary.id);
    }
    replaceGraph(syncedGraph);
    setSyncOverview(overview);
    reconcileSelection(syncedGraph);
  }

  function beginAction() {
    setErrorMessage(null);
    setPendingActions((current) => current + 1);
  }

  function finishAction() {
    setPendingActions((current) => Math.max(0, current - 1));
  }

  async function restoreHistory(direction: "undo" | "redo") {
    if (historyBlocked) {
      return;
    }
    const libraryId = activeLibrary.id;
    const history = historyByLibrary[libraryId];
    const source = direction === "undo" ? history?.undo : history?.redo;
    const entry = source?.[source.length - 1];
    if (!entry) {
      return;
    }
    const target = cloneGraphSnapshot(
      direction === "undo" ? entry.before : entry.after,
    );
    beginAction();
    try {
      await graphRepository.restoreHistorySnapshot(target);
      replaceGraph(target);
      reconcileSelection(target);
      setEditor(null);
      setLayoutPreview(null);
      setEmptyStateDismissed(target.positions.length > 0);
      setHistoryByLibrary((current) => {
        const currentHistory = current[libraryId];
        if (!currentHistory) {
          return current;
        }
        return {
          ...current,
          [libraryId]:
            direction === "undo"
              ? {
                  undo: currentHistory.undo.slice(0, -1),
                  redo: [...currentHistory.redo, entry],
                }
              : {
                  undo: [...currentHistory.undo, entry].slice(-HISTORY_LIMIT),
                  redo: currentHistory.redo.slice(0, -1),
                },
        };
      });
    } catch (error) {
      setErrorMessage(
        getErrorMessage(
          direction === "undo" ? "Could not undo the change" : "Could not redo the change",
          error,
        ),
      );
    } finally {
      finishAction();
    }
  }

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.matches("input, textarea, select"))
      ) {
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "z" && event.shiftKey && canRedo) {
        event.preventDefault();
        void restoreHistory("redo");
      } else if (key === "z" && !event.shiftKey && canUndo) {
        event.preventDefault();
        void restoreHistory("undo");
      } else if (key === "y" && !event.shiftKey && canRedo) {
        event.preventDefault();
        void restoreHistory("redo");
      }
    };
    window.addEventListener("keydown", handleHistoryShortcut);
    return () => window.removeEventListener("keydown", handleHistoryShortcut);
  }, [canRedo, canUndo, historyByLibrary, historyBlocked]);

  async function movePosition(positionId: string, coordinates: XYPosition) {
    if (layoutPreview || pendingActions > 0) {
      return;
    }
    const before = cloneGraphSnapshot(graphRef.current);
    beginAction();
    try {
      await graphRepository.movePosition(positionId, coordinates);
      const current = graphRef.current;
      commitGraphChange(before, {
        ...current,
        positions: current.positions.map((position) =>
          position.id === positionId
            ? { ...position, x: coordinates.x, y: coordinates.y }
            : position,
        ),
      });
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not save the position layout", error));
      replaceGraph({
        ...graphRef.current,
        positions: graphRef.current.positions.map((position) => ({ ...position })),
      });
    } finally {
      finishAction();
    }
  }

  async function savePosition(position: Position) {
    const before = cloneGraphSnapshot(graphRef.current);
    beginAction();
    try {
      await graphRepository.savePosition(position);
      const current = graphRef.current;
      commitGraphChange(before, {
        ...current,
        positions: current.positions.some((item) => item.id === position.id)
          ? current.positions.map((item) =>
              item.id === position.id ? position : item,
            )
          : [...current.positions, position],
      });
      setSelection({ type: "position", id: position.id });
      if (isMobileLayout) {
        setMobileView("details");
      }
      setEditor(null);
      setEmptyStateDismissed(true);
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not save the position", error));
    } finally {
      finishAction();
    }
  }

  async function saveTechnique({
    technique,
    targetMode,
  }: TechniqueSaveRequest) {
    const before = cloneGraphSnapshot(graphRef.current);
    beginAction();
    try {
      if (targetMode === "create") {
        const current = graphRef.current;
        const targetDraft = {
          ...createPosition(current.positions.length),
          name: technique.name,
        };
        const linkedTechnique = {
          ...technique,
          targetPositionId: targetDraft.id,
        };
        const targetPosition = await placeNewTargetPosition(
          current.positions,
          current.techniques,
          targetDraft,
          linkedTechnique,
        );

        await graphRepository.savePosition(targetPosition);
        try {
          await graphRepository.saveTechnique(linkedTechnique);
        } catch (error) {
          const latest = graphRef.current;
          commitGraphChange(before, {
            ...latest,
            positions: [...latest.positions, targetPosition],
          });
          setSelection({ type: "position", id: targetPosition.id });
          if (isMobileLayout) {
            setMobileView("details");
          }
          setEditor(null);
          setEmptyStateDismissed(true);
          setErrorMessage(
            getErrorMessage(
              "Position created, but transition could not be saved",
              error,
            ),
          );
          return;
        }

        const latest = graphRef.current;
        commitGraphChange(before, {
          ...latest,
          positions: [...latest.positions, targetPosition],
          techniques: latest.techniques.some(
            (item) => item.id === linkedTechnique.id,
          )
            ? latest.techniques.map((item) =>
                item.id === linkedTechnique.id ? linkedTechnique : item,
              )
            : [...latest.techniques, linkedTechnique],
        });
        setSelection({ type: "technique", id: linkedTechnique.id });
        if (isMobileLayout) {
          setMobileView("details");
        }
        setEditor(null);
        setEmptyStateDismissed(true);
        return;
      }

      await graphRepository.saveTechnique(technique);
      const current = graphRef.current;
      commitGraphChange(before, {
        ...current,
        techniques: current.techniques.some((item) => item.id === technique.id)
          ? current.techniques.map((item) =>
              item.id === technique.id ? technique : item,
            )
          : [...current.techniques, technique],
      });
      setSelection({ type: "technique", id: technique.id });
      if (isMobileLayout) {
        setMobileView("details");
      }
      setEditor(null);
    } catch (error) {
      setErrorMessage(
        getErrorMessage(
          targetMode === "create"
            ? "Could not create the target position"
            : "Could not save the transition",
          error,
        ),
      );
    } finally {
      finishAction();
    }
  }

  function editSelection() {
    if (selection?.type === "position") {
      const position = graph.positions.find((item) => item.id === selection.id);
      if (position) {
        setEditor({ type: "position", entity: position, isNew: false });
      }
    }
    if (selection?.type === "technique") {
      const technique = graph.techniques.find((item) => item.id === selection.id);
      if (technique) {
        setEditor({ type: "technique", entity: technique, isNew: false });
      }
    }
  }

  async function deleteSelection() {
    if (!selection) {
      return;
    }

    if (selection.type === "technique") {
      const technique = graph.techniques.find((item) => item.id === selection.id);
      if (!technique || !window.confirm(`Delete “${technique.name}”?`)) {
        return;
      }
      const before = cloneGraphSnapshot(graphRef.current);
      beginAction();
      try {
        await graphRepository.deleteTechnique(technique.id);
        const current = graphRef.current;
        commitGraphChange(before, {
          ...current,
          techniques: current.techniques.filter((item) => item.id !== technique.id),
          attachments: current.attachments.filter(
            (attachment) => attachment.ownerId !== technique.id,
          ),
        });
      } catch (error) {
        setErrorMessage(getErrorMessage("Could not delete the transition", error));
        return;
      } finally {
        finishAction();
      }
    } else {
      const position = graph.positions.find((item) => item.id === selection.id);
      if (!position) {
        return;
      }
      const affectedTechniqueIds = graph.techniques
        .filter(
          (technique) =>
            technique.sourcePositionId === position.id ||
            technique.targetPositionId === position.id,
        )
        .map((technique) => technique.id);
      const message =
        affectedTechniqueIds.length > 0
          ? `Delete “${position.name}” and ${affectedTechniqueIds.length} connected transition${affectedTechniqueIds.length === 1 ? "" : "s"}?`
          : `Delete “${position.name}”?`;
      if (!window.confirm(message)) {
        return;
      }
      const removedIds = new Set([position.id, ...affectedTechniqueIds]);
      const before = cloneGraphSnapshot(graphRef.current);
      beginAction();
      try {
        await graphRepository.deletePosition(position.id);
        const current = graphRef.current;
        commitGraphChange(before, {
          positions: current.positions.filter((item) => item.id !== position.id),
          techniques: current.techniques.filter(
            (technique) => !affectedTechniqueIds.includes(technique.id),
          ),
          attachments: current.attachments.filter(
            (attachment) => !removedIds.has(attachment.ownerId),
          ),
        });
      } catch (error) {
        setErrorMessage(getErrorMessage("Could not delete the position", error));
        return;
      } finally {
        finishAction();
      }
    }
    setSelection(null);
    setFocusSelection(false);
    if (isMobileLayout) {
      setMobileView("map");
    }
  }

  function openNewPosition() {
    setEmptyStateDismissed(true);
    setEditor({
      type: "position",
      entity: createPosition(graph.positions.length),
      isNew: true,
    });
  }

  function openNewTechnique(sourcePositionId: string) {
    setEditor({
      type: "technique",
      entity: createTechnique(sourcePositionId),
      isNew: true,
    });
  }

  async function importStarterMap() {
    const before = cloneGraphSnapshot(graphRef.current);
    beginAction();
    try {
      const importedGraph = await graphRepository.importGraph(sampleGraph);
      commitGraphChange(before, importedGraph);
      setEmptyStateDismissed(true);
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not import the starter map", error));
    } finally {
      finishAction();
    }
  }

  async function saveAttachment(attachment: Attachment) {
    const before = cloneGraphSnapshot(graphRef.current);
    beginAction();
    try {
      await graphRepository.saveAttachment(attachment);
      const current = graphRef.current;
      commitGraphChange(before, {
        ...current,
        attachments: current.attachments.some((item) => item.id === attachment.id)
          ? current.attachments.map((item) =>
              item.id === attachment.id ? attachment : item,
            )
          : [...current.attachments, attachment],
      });
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not save the source", error));
    } finally {
      finishAction();
    }
  }

  async function addMediaAttachment(
    ownerType: Attachment["ownerType"],
    ownerId: string,
    kind: Extract<Attachment["kind"], "image" | "video">,
  ) {
    if (kind === "video") {
      await prepareVideoAttachment(ownerType, ownerId);
      return;
    }

    const before = cloneGraphSnapshot(graphRef.current);
    let attachment: Attachment | null = null;
    beginAction();
    try {
      attachment = await pickMediaAttachment(
        ownerType,
        ownerId,
        kind,
        activeLibrary.mediaDirectory,
        activeLibrary.databaseUrl,
      );
      if (!attachment) {
        return;
      }
      await graphRepository.saveAttachment(attachment);
      const current = graphRef.current;
      commitGraphChange(before, {
        ...current,
        attachments: [...current.attachments, attachment as Attachment],
      });
    } catch (error) {
      if (attachment) {
        await deleteImportedMedia(attachment).catch(() => undefined);
      }
      setErrorMessage(getErrorMessage(`Could not import the ${kind}`, error));
    } finally {
      finishAction();
    }
  }

  async function prepareVideoAttachment(
    ownerType: Attachment["ownerType"],
    ownerId: string,
    sourcePath?: string,
  ) {
    beginAction();
    try {
      const draft = sourcePath
        ? await prepareVideoImportFromPath(
            ownerType,
            ownerId,
            sourcePath,
            activeLibrary.mediaDirectory,
            activeLibrary.databaseUrl,
          )
        : await prepareVideoImport(
            ownerType,
            ownerId,
            activeLibrary.mediaDirectory,
            activeLibrary.databaseUrl,
          );
      if (draft) {
        setVideoImportDraft(draft);
      }
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not prepare the video", error));
    } finally {
      finishAction();
    }
  }

  async function confirmVideoImport(options: VideoImportOptions) {
    if (!videoImportDraft) {
      return;
    }
    const draft = videoImportDraft;
    const before = cloneGraphSnapshot(graphRef.current);
    let attachment: Attachment | null = null;
    setVideoProcessingId(draft.id);
    beginAction();
    try {
      attachment = await finishVideoImport(draft, options);
      await graphRepository.saveAttachment(attachment);
      const current = graphRef.current;
      commitGraphChange(before, {
        ...current,
        attachments: [...current.attachments, attachment as Attachment],
      });
      setVideoImportDraft(null);
    } catch (error) {
      if (isVideoProcessingCancelled(error)) {
        await discardVideoImport(draft).catch(() => undefined);
        setVideoImportDraft((current) => current?.id === draft.id ? null : current);
        return;
      }
      if (attachment) {
        await deleteImportedMedia(attachment).catch(() => undefined);
        setVideoImportDraft(null);
      }
      setErrorMessage(getErrorMessage("Could not import the video", error));
    } finally {
      setVideoProcessingId((current) => current === draft.id ? null : current);
      finishAction();
    }
  }

  async function cancelVideoImport() {
    if (!videoImportDraft) {
      return;
    }
    const draft = videoImportDraft;
    if (videoProcessingId === draft.id) {
      try {
        await cancelVideoProcessing(draft.id);
      } catch (error) {
        setErrorMessage(getErrorMessage("Could not cancel video processing", error));
      }
      return;
    }
    beginAction();
    try {
      await discardVideoImport(draft);
      setVideoImportDraft(null);
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not remove the staged video", error));
    } finally {
      finishAction();
    }
  }

  async function deleteAttachment(attachment: Attachment) {
    if (!window.confirm(`Delete “${attachment.title}”?`)) {
      return;
    }
    const before = cloneGraphSnapshot(graphRef.current);
    beginAction();
    try {
      await graphRepository.deleteAttachment(attachment.id);
      const current = graphRef.current;
      commitGraphChange(before, {
        ...current,
        attachments: current.attachments.filter(
          (item) => item.id !== attachment.id,
        ),
      });
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not delete the source", error));
    } finally {
      finishAction();
    }
  }

  async function downloadAttachment(attachment: Attachment) {
    beginAction();
    try {
      await downloadMediaAttachment(activeLibrary.syncLibraryId, attachment);
      const downloadedGraph = await graphRepository.loadGraph();
      if (!graphSnapshotsEqual(graphRef.current, downloadedGraph)) {
        clearLibraryHistory(activeLibrary.id);
      }
      replaceGraph(downloadedGraph);
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not download the media", error));
    } finally {
      finishAction();
    }
  }

  async function openStoredAttachment(attachment: Attachment) {
    try {
      await openAttachment(attachment);
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not open the link", error));
    }
  }

  async function previewAutomaticLayout() {
    setErrorMessage(null);
    setIsArranging(true);
    try {
      setLayoutPreview(await createAutomaticLayout(graph.positions, graph.techniques));
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not arrange the graph", error));
    } finally {
      setIsArranging(false);
    }
  }

  async function applyAutomaticLayout() {
    if (!layoutPreview) {
      return;
    }
    const before = cloneGraphSnapshot(graphRef.current);
    beginAction();
    try {
      await graphRepository.saveLayout(layoutPreview);
      commitGraphChange(before, { ...graphRef.current, positions: layoutPreview });
      setLayoutPreview(null);
    } catch (error) {
      setErrorMessage(getErrorMessage("Could not save the layout", error));
    } finally {
      finishAction();
    }
  }

  function selectEntity(nextSelection: GraphSelection) {
    setSelection(nextSelection);
    if (nextSelection && isMobileLayout) {
      setMobileView("details");
    }
    if (!nextSelection) {
      setFocusSelection(false);
    }
  }

  function selectLibraryResult(nextSelection: GraphSelection) {
    clearFilters();
    setQuery("");
    setFocusSelection(false);
    setSelection(nextSelection);
    if (isMobileLayout) {
      setMobileView("details");
    }
    setRevealRequest((current) => current + 1);
  }

  function changeMobileView(nextView: MobileView) {
    if (nextView === "map" && inspectorMode === "full") {
      setInspectorMode("partial");
    }
    if (nextView === "details" && inspectorMode === "hidden") {
      setInspectorMode("partial");
    }
    setMobileView(nextView);
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const handleVideoDrop = (event: VideoDragDropEvent) => {
      if (event.type === "leave") {
        setIsVideoDropActive(false);
        return;
      }
      if (event.type === "enter") {
        setIsVideoDropActive(
          !historyBlocked &&
            Boolean(videoDropOwner) &&
            event.paths.length === 1 &&
            isSupportedVideoDropPath(event.paths[0]),
        );
        return;
      }
      if (event.type !== "drop") {
        return;
      }

      setIsVideoDropActive(false);
      if (historyBlocked) {
        return;
      }
      if (!videoDropOwner) {
        setErrorMessage(
          "Could not import the dropped video: select a position or transition first",
        );
        return;
      }
      if (event.paths.length !== 1) {
        setErrorMessage(
          "Could not import the dropped video: drop one video file at a time",
        );
        return;
      }
      const [sourcePath] = event.paths;
      if (!isSupportedVideoDropPath(sourcePath)) {
        setErrorMessage(
          "Could not import the dropped video: use an MP4, MOV, or M4V file",
        );
        return;
      }
      void prepareVideoAttachment(
        videoDropOwner.ownerType,
        videoDropOwner.ownerId,
        sourcePath,
      );
    };

    void subscribeToMacOSVideoDrops(handleVideoDrop)
      .then((nextUnlisten) => {
        if (disposed) {
          nextUnlisten?.();
        } else {
          unlisten = nextUnlisten;
        }
      })
      .catch((error) => {
        if (!disposed) {
          setErrorMessage(getErrorMessage("Could not enable video drag and drop", error));
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    activeLibrary.databaseUrl,
    activeLibrary.mediaDirectory,
    historyBlocked,
    videoDropOwner?.ownerId,
    videoDropOwner?.ownerType,
  ]);

  useEffect(() => {
    const handleAndroidBack = (): AndroidBackResult => {
      if (window.__ROLLMAP_CLOSE_ACTIVE_OVERLAY__?.()) {
        return "handled";
      }
      if (videoImportDraft) {
        void cancelVideoImport();
        return "handled";
      }
      if (editor) {
        setEditor(null);
        return "handled";
      }
      if (isSyncDialogOpen) {
        setIsSyncDialogOpen(false);
        return "handled";
      }
      if (layoutPreview) {
        setLayoutPreview(null);
        return "handled";
      }
      if (pendingActions > 0 || isArranging) {
        return "handled";
      }
      if (isMobileLayout && mobileView !== "map") {
        changeMobileView("map");
        return "handled";
      }
      return "exit";
    };

    window.__ROLLMAP_HANDLE_ANDROID_BACK__ = handleAndroidBack;
    return () => {
      if (window.__ROLLMAP_HANDLE_ANDROID_BACK__ === handleAndroidBack) {
        delete window.__ROLLMAP_HANDLE_ANDROID_BACK__;
      }
    };
  }, [
    editor,
    isArranging,
    isMobileLayout,
    isSyncDialogOpen,
    inspectorMode,
    layoutPreview,
    mobileView,
    pendingActions,
    videoImportDraft,
    videoProcessingId,
  ]);

  return (
    <main className="app-shell">
      <header className="app-toolbar">
        <div className="brand-block" data-tauri-drag-region>
          <div className="brand-mark">
            <Network size={19} />
          </div>
          <div>
            <strong>Rollmap</strong>
            <span>Jiu-jitsu atlas</span>
          </div>
        </div>
        <LibrarySwitcher
          libraries={libraryCatalog.libraries}
          activeLibraryId={activeLibrary.id}
          isBusy={
            isCatalogLoading ||
            isLoading ||
            isArranging ||
            pendingActions > 0 ||
            videoImportDraft !== null
          }
          onChange={changeLibrary}
          onCreate={createLibrary}
          onRename={renameLibrary}
          onDelete={deleteLibrary}
        />
        <label className="global-search">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (isMobileLayout) {
                setMobileView("browse");
              }
            }}
            onFocus={() => {
              if (isMobileLayout) {
                setMobileView("browse");
              }
            }}
            placeholder="Search positions and transitions"
            aria-label="Search positions and transitions"
          />
          {query && (
            <button
              type="button"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <div className="toolbar-actions">
          <button
            type="button"
            className={`sync-status-button sync-status-button--${syncPresentation.tone}`}
            onClick={() => setIsSyncDialogOpen(true)}
            disabled={
              isCatalogLoading ||
              isLoading ||
              isArranging ||
              pendingActions > 0 ||
              videoImportDraft !== null
            }
            title={syncPresentation.detail}
            aria-label={`Sync devices: ${syncPresentation.label}`}
          >
            <Network size={16} />
            <span>{syncPresentation.label}</span>
          </button>
          <div className="history-controls" role="group" aria-label="Edit history">
            <button
              type="button"
              onClick={() => void restoreHistory("undo")}
              disabled={!canUndo}
              title="Undo"
              aria-label="Undo last change"
            >
              <Undo2 size={16} />
            </button>
            <button
              type="button"
              onClick={() => void restoreHistory("redo")}
              disabled={!canRedo}
              title="Redo"
              aria-label="Redo last change"
            >
              <Redo2 size={16} />
            </button>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void previewAutomaticLayout()}
            disabled={
              isLoading ||
              isArranging ||
              pendingActions > 0 ||
              graph.positions.length < 2 ||
              layoutPreview !== null
            }
            title="Preview automatic layout"
          >
            {isArranging ? <LoaderCircle className="is-spinning" size={15} /> : <LayoutGrid size={15} />}
            {isArranging ? "Arranging" : "Arrange"}
          </button>
          <button
            type="button"
            className={`secondary-button${focusSelection ? " is-active" : ""}`}
            onClick={() => selection && setFocusSelection((current) => !current)}
            disabled={!selection || isLoading || isArranging || layoutPreview !== null}
            title="Focus selected neighborhood"
          >
            <Focus size={15} />
            Focus
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={openNewPosition}
            disabled={isLoading || isArranging || pendingActions > 0 || layoutPreview !== null}
          >
            <Plus size={16} />
            Position
          </button>
          <div className="inspector-mode-control" role="group" aria-label="Details panel size">
            <button
              type="button"
              className={inspectorMode === "hidden" ? "is-active" : ""}
              title="Hide details panel"
              aria-label="Hide details panel"
              aria-pressed={inspectorMode === "hidden"}
              onClick={() => setInspectorMode("hidden")}
            >
              <PanelRightClose size={16} />
            </button>
            <button
              type="button"
              className={inspectorMode === "partial" ? "is-active" : ""}
              title="Show standard details panel"
              aria-label="Show standard details panel"
              aria-pressed={inspectorMode === "partial"}
              onClick={() => setInspectorMode("partial")}
            >
              <PanelRight size={16} />
            </button>
            <button
              type="button"
              className={inspectorMode === "full" ? "is-active" : ""}
              title="Expand details panel over graph"
              aria-label="Expand details panel over graph"
              aria-pressed={inspectorMode === "full"}
              onClick={() => setInspectorMode("full")}
            >
              <PanelRightOpen size={16} />
            </button>
          </div>
        </div>
      </header>

      <div
        className={`workspace-grid workspace-grid--inspector-${inspectorMode} workspace-grid--mobile-${mobileView}`}
      >
        <LibrarySidebar
          positions={graph.positions}
          techniques={graph.techniques}
          query={query}
          category={category}
          role={role}
          giMode={giMode}
          difficulty={difficulty}
          activeTag={activeTag}
          onCategoryChange={setCategory}
          onRoleChange={setRole}
          onGiModeChange={setGiMode}
          onDifficultyChange={setDifficulty}
          onTagChange={setActiveTag}
          onSelect={selectLibraryResult}
        />
        {(isMobileLayout || inspectorMode !== "full") && <section className="graph-workspace">
          {layoutPreview === null && <div className="mobile-map-tools" aria-label="Map tools">
            <button
              type="button"
              className="icon-button"
              onClick={() => void previewAutomaticLayout()}
              disabled={
                isLoading ||
                isArranging ||
                pendingActions > 0 ||
                graph.positions.length < 2 ||
                layoutPreview !== null
              }
              title="Preview automatic layout"
              aria-label="Preview automatic layout"
            >
              {isArranging ? (
                <LoaderCircle className="is-spinning" size={16} />
              ) : (
                <LayoutGrid size={16} />
              )}
            </button>
            <button
              type="button"
              className={`icon-button${focusSelection ? " is-active" : ""}`}
              onClick={() => selection && setFocusSelection((current) => !current)}
              disabled={!selection || isLoading || isArranging || layoutPreview !== null}
              title={focusSelection ? "Show full graph" : "Focus selected neighborhood"}
              aria-label={focusSelection ? "Show full graph" : "Focus selected neighborhood"}
            >
              <Focus size={16} />
            </button>
          </div>}
          {layoutPreview && (
            <div className="layout-preview-controls" role="status">
              <span>Layout preview</span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setLayoutPreview(null)}
                disabled={pendingActions > 0}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void applyAutomaticLayout()}
                disabled={pendingActions > 0}
              >
                Apply
              </button>
            </div>
          )}
          {isLoading && (
            <div className="workspace-state workspace-state--loading" role="status">
              <LoaderCircle size={22} />
              <span>Loading knowledge base</span>
            </div>
          )}
          {!isLoading && graph.positions.length === 0 && !emptyStateDismissed && (
            <div className="workspace-state workspace-state--empty">
              <Database size={30} />
              <h2>Your atlas is empty</h2>
              <p>Begin with a blank position or load a small editable starter map.</p>
              <div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={openNewPosition}
                  disabled={pendingActions > 0}
                >
                  <Plus size={15} />
                  First position
                </button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void importStarterMap()}
                  disabled={pendingActions > 0}
                >
                  Load starter map
                </button>
              </div>
            </div>
          )}
          {hasActiveFilters && (
            <div className="active-filters">
              {category !== "all" && <span>{category}</span>}
              {role !== "all" && <span>{role}</span>}
              {giMode !== "all" && <span>{formatFilterLabel(giMode)}</span>}
              {difficulty !== "all" && <span>{difficulty}</span>}
              {activeTag && <span>#{activeTag}</span>}
              <button type="button" onClick={clearFilters}>
                Clear
              </button>
            </div>
          )}
          <GraphCanvas
            positions={visibleGraph.positions}
            techniques={visibleGraph.techniques}
            selection={selection}
            focusSelection={focusSelection}
            revealRequest={revealRequest}
            readOnly={isArranging || pendingActions > 0 || layoutPreview !== null}
            onSelect={selectEntity}
            onMovePosition={movePosition}
            onConnectPositions={(sourcePositionId, targetPositionId) =>
              setEditor({
                type: "technique",
                entity: createTechnique(sourcePositionId, targetPositionId),
                isNew: true,
              })
            }
          />
        </section>}
        {(isMobileLayout || inspectorMode !== "hidden") && (
          <DetailInspector
            selection={selection}
            positions={graph.positions}
            techniques={graph.techniques}
            attachments={graph.attachments}
            isBusy={isArranging || pendingActions > 0 || layoutPreview !== null}
            isActive={!isMobileLayout || mobileView === "details"}
            focusSelection={focusSelection}
            onToggleFocus={() => setFocusSelection((current) => !current)}
            onEdit={editSelection}
            onDelete={deleteSelection}
            onAddTechnique={openNewTechnique}
            onSelectTechnique={(techniqueId) =>
              selectEntity({ type: "technique", id: techniqueId })
            }
            onSaveAttachment={(attachment) => void saveAttachment(attachment)}
            onAddMedia={(ownerType, ownerId, kind) =>
              void addMediaAttachment(ownerType, ownerId, kind)
            }
            onDeleteAttachment={(attachment) => void deleteAttachment(attachment)}
            onDownloadAttachment={(attachment) => void downloadAttachment(attachment)}
            onOpenAttachment={(attachment) => void openStoredAttachment(attachment)}
          />
        )}
      </div>

      <nav className="mobile-workspace-nav" aria-label="Workspace views">
        <button
          type="button"
          className={mobileView === "browse" ? "is-active" : ""}
          aria-current={mobileView === "browse" ? "page" : undefined}
          onClick={() => changeMobileView("browse")}
        >
          <ListFilter size={19} />
          <span>Browse</span>
        </button>
        <button
          type="button"
          className={mobileView === "map" ? "is-active" : ""}
          aria-current={mobileView === "map" ? "page" : undefined}
          onClick={() => changeMobileView("map")}
        >
          <MapIcon size={19} />
          <span>Map</span>
        </button>
        <button
          type="button"
          className={mobileView === "details" ? "is-active" : ""}
          aria-current={mobileView === "details" ? "page" : undefined}
          onClick={() => changeMobileView("details")}
        >
          <PanelRight size={19} />
          <span>Details</span>
        </button>
      </nav>

      {isVideoDropActive && videoDropOwner && (
        <div className="video-drop-overlay" role="status" aria-live="polite">
          <Film size={28} />
          <div>
            <strong>Release to import video</strong>
            <span>{videoDropOwner.label}</span>
          </div>
        </div>
      )}

      {(errorMessage || pendingActions > 0) && (
        <div
          className={`persistence-status${errorMessage ? " persistence-status--error" : ""}`}
          role={errorMessage ? "alert" : "status"}
        >
          {errorMessage ? (
            <AlertTriangle size={16} />
          ) : (
            <LoaderCircle className="is-spinning" size={16} />
          )}
          <span>{errorMessage ?? "Saving changes"}</span>
          {errorMessage && (
            <button
              type="button"
              title="Dismiss"
              aria-label="Dismiss error"
              onClick={() => setErrorMessage(null)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}

      {isSyncDialogOpen && (
        <SyncDialog
          onClose={() => setIsSyncDialogOpen(false)}
          onCatalogChanged={refreshCatalogAfterPairing}
          onSyncComplete={refreshGraphAfterSync}
          activeLibraryName={activeLibrary.name}
          activeSyncLibraryId={activeLibrary.syncLibraryId}
          syncActivity={syncActivity}
          syncOverview={syncOverview}
          onMediaDownloadComplete={refreshGraphAfterSync}
        />
      )}

      {editor?.type === "position" && (
        <PositionEditorDialog
          key={editor.entity.id}
          position={editor.entity}
          isNew={editor.isNew}
          isSaving={pendingActions > 0}
          onSave={savePosition}
          onClose={() => setEditor(null)}
        />
      )}
      {editor?.type === "technique" && (
        <TechniqueEditorDialog
          key={editor.entity.id}
          technique={editor.entity}
          positions={graph.positions}
          isNew={editor.isNew}
          isSaving={pendingActions > 0}
          onSave={saveTechnique}
          onClose={() => setEditor(null)}
        />
      )}
      {videoImportDraft && (
        <VideoImportDialog
          draft={videoImportDraft}
          isBusy={videoProcessingId === videoImportDraft.id}
          canCancelWhileBusy={canCancelVideoProcessing()}
          onConfirm={(options) => void confirmVideoImport(options)}
          onCancel={() => void cancelVideoImport()}
        />
      )}
    </main>
  );
}

export default App;
