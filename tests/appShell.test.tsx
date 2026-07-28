import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const videoDrop = vi.hoisted(() => ({
  listener: null as null | ((event: {
    type: "enter" | "over" | "drop" | "leave";
    paths?: string[];
  }) => void),
  prepareVideoImportFromPath: vi.fn(),
}));

vi.mock("../src/services/videoDrop", () => ({
  isSupportedVideoDropPath: (path: string) => /\.(?:mp4|mov|m4v)$/i.test(path),
  subscribeToMacOSVideoDrops: vi.fn(async (listener) => {
    videoDrop.listener = listener;
    return vi.fn();
  }),
}));
vi.mock("../src/services/media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/media")>()),
  prepareVideoImportFromPath: videoDrop.prepareVideoImportFromPath,
}));
vi.mock("../src/features/graph/GraphCanvas", () => ({
  GraphCanvas: ({
    positions,
    techniques,
    onSelect,
    onMovePosition,
    onConnectPositions,
  }: {
    positions: Array<{ id: string; name: string; x: number; y: number }>;
    techniques: Array<{ id: string }>;
    onSelect: (selection: { type: "position"; id: string }) => void;
    onMovePosition: (
      positionId: string,
      coordinates: { x: number; y: number },
    ) => void;
    onConnectPositions: (
      sourcePositionId: string,
      targetPositionId: string | null,
    ) => void;
  }) => (
    <div
      data-testid="graph-canvas"
      data-position-count={positions.length}
      data-technique-count={techniques.length}
      data-first-position-x={positions[0]?.x}
      data-last-position-name={positions.at(-1)?.name}
    >
      <button
        type="button"
        onClick={() =>
          onSelect({ type: "position", id: positions[0]?.id ?? "map-position" })
        }
      >
        Select map position
      </button>
      <button
        type="button"
        disabled={positions.length === 0}
        onClick={() => onMovePosition(positions[0].id, { x: 999, y: 777 })}
      >
        Move first position
      </button>
      <button
        type="button"
        disabled={positions.length === 0}
        onClick={() => onConnectPositions(positions[0].id, null)}
      >
        Create transition target
      </button>
    </div>
  ),
}));
vi.mock("../src/features/search/LibrarySidebar", () => ({
  LibrarySidebar: ({
    onSelect,
  }: {
    onSelect: (selection: { type: "position"; id: string }) => void;
  }) => (
    <aside data-testid="library-sidebar">
      <button
        type="button"
        onClick={() => onSelect({ type: "position", id: "browse-position" })}
      >
        Select browse result
      </button>
    </aside>
  ),
}));
vi.mock("../src/features/editor/DetailInspector", () => ({
  DetailInspector: ({ isActive }: { isActive: boolean }) => (
    <aside data-testid="detail-inspector" data-active={String(isActive)} />
  ),
}));
vi.mock("../src/features/editor/EntityEditorDialog", () => ({
  PositionEditorDialog: () => null,
  TechniqueEditorDialog: ({
    technique,
    onSave,
  }: {
    technique: {
      id: string;
      sourcePositionId: string;
      targetPositionId: string | null;
    };
    onSave: (request: {
      technique: typeof technique & { name: string };
      targetMode: "create";
    }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onSave({
          technique: { ...technique, name: "Butterfly Sweep" },
          targetMode: "create",
        })
      }
    >
      Submit generated transition
    </button>
  ),
}));
vi.mock("../src/features/editor/VideoImportDialog", () => ({
  VideoImportDialog: ({ draft }: { draft: { title: string } }) => (
    <div role="dialog" aria-label={`Video import options: ${draft.title}`} />
  ),
}));

import App from "../src/App";
import { getGraphRepository } from "../src/data/graphRepository";

type AndroidBackWindow = Window & {
  __ROLLMAP_HANDLE_ANDROID_BACK__?: () => "handled" | "exit";
};

function dispatchAndroidBack() {
  let result: "handled" | "exit" | undefined;
  act(() => {
    result = (window as AndroidBackWindow).__ROLLMAP_HANDLE_ANDROID_BACK__?.();
  });
  return result;
}

function setMobileLayout(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((media: string) => ({
      matches,
      media,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("application shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete (window as AndroidBackWindow).__ROLLMAP_HANDLE_ANDROID_BACK__;
    delete window.__ROLLMAP_CLOSE_ACTIVE_OVERLAY__;
    videoDrop.listener = null;
    videoDrop.prepareVideoImportFromPath.mockReset();
    videoDrop.prepareVideoImportFromPath.mockImplementation(
      async (ownerType: "position" | "technique", ownerId: string) => ({
        id: "dropped-video",
        ownerType,
        ownerId,
        title: "Mounted roll",
        mediaDirectory: "media",
        databaseUrl: "sqlite:rollmap.db",
        sourceRelativePath: "media/staging/dropped-video.mov",
        previewUrl: "asset://dropped-video-preview",
      }),
    );
    setMobileLayout(false);
  });

  it("switches the details panel between hidden, standard, and full modes", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);

    const workspace = container.querySelector(".workspace-grid");
    const standardButton = screen.getByRole("button", {
      name: "Show standard details panel",
    });
    expect(standardButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("detail-inspector")).toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toBeInTheDocument();
    expect(workspace).toHaveClass("workspace-grid--inspector-partial");

    await user.click(screen.getByRole("button", {
      name: "Expand details panel over graph",
    }));
    expect(workspace).toHaveClass("workspace-grid--inspector-full");
    expect(screen.getByTestId("detail-inspector")).toBeInTheDocument();
    expect(screen.queryByTestId("graph-canvas")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", {
      name: "Hide details panel",
    }));
    expect(workspace).toHaveClass("workspace-grid--inspector-hidden");
    expect(screen.queryByTestId("detail-inspector")).not.toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toBeInTheDocument();

    await user.click(screen.getByRole("button", {
      name: "Show standard details panel",
    }));
    expect(workspace).toHaveClass("workspace-grid--inspector-partial");
    expect(screen.getByTestId("detail-inspector")).toBeInTheDocument();
    expect(screen.getByTestId("graph-canvas")).toBeInTheDocument();
  });

  it("creates and activates a new empty knowledge database", async () => {
    const user = userEvent.setup();
    render(<App />);

    const createButton = screen.getByRole("button", { name: "New database" });
    await waitFor(() => expect(createButton).toBeEnabled());
    await user.click(createButton);
    await user.type(screen.getByLabelText("Name"), "Competition game");
    await user.click(screen.getByRole("button", { name: "Create database" }));

    const selector = screen.getByLabelText("Knowledge database");
    await waitFor(() => expect(selector).toHaveDisplayValue("Competition game"));
    expect(screen.getByRole("option", { name: "Default database" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Competition game" })).toBeInTheDocument();
  });

  it("renames and deletes a custom knowledge database", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New database" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "New database" }));
    await user.type(screen.getByLabelText("Name"), "Competition game");
    await user.click(screen.getByRole("button", { name: "Create database" }));

    await user.click(screen.getByRole("button", { name: "Rename database" }));
    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Guard study");
    await user.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Knowledge database")).toHaveDisplayValue(
        "Guard study",
      ),
    );

    await user.click(screen.getByRole("button", { name: "Delete database" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Knowledge database")).toHaveDisplayValue(
        "Default database",
      ),
    );
    expect(confirm).toHaveBeenCalledWith('Delete "Guard study" from this device?');
    expect(screen.queryByRole("option", { name: "Guard study" })).not.toBeInTheDocument();
  });

  it("opens device sync from the toolbar", async () => {
    const user = userEvent.setup();
    render(<App />);

    const syncButton = screen.getByRole("button", {
      name: "Sync devices: Not paired",
    });
    await waitFor(() => expect(syncButton).toBeEnabled());
    await user.click(syncButton);

    expect(
      screen.getByRole("dialog", { name: "Sync devices" }),
    ).toBeInTheDocument();
  });

  it("undoes and redoes a graph change from shared history controls", async () => {
    const user = userEvent.setup();
    render(<App />);

    const undoButton = screen.getByRole("button", { name: "Undo last change" });
    const redoButton = screen.getByRole("button", { name: "Redo last change" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Load starter map" })).toBeEnabled(),
    );
    expect(undoButton).toBeDisabled();
    expect(redoButton).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Load starter map" }));
    await waitFor(() => expect(undoButton).toBeEnabled());
    expect(screen.getByTestId("graph-canvas")).not.toHaveAttribute(
      "data-position-count",
      "0",
    );

    await user.click(undoButton);
    await waitFor(() =>
      expect(screen.getByTestId("graph-canvas")).toHaveAttribute(
        "data-position-count",
        "0",
      ),
    );
    expect(redoButton).toBeEnabled();

    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("graph-canvas")).not.toHaveAttribute(
        "data-position-count",
        "0",
      ),
    );
    expect(undoButton).toBeEnabled();

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("graph-canvas")).toHaveAttribute(
        "data-position-count",
        "0",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Load starter map" }));
    await waitFor(() => expect(undoButton).toBeEnabled());
    expect(redoButton).toBeDisabled();
  });

  it("records position movement as one reversible graph change", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Load starter map" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Load starter map" }));
    const canvas = screen.getByTestId("graph-canvas");
    const initialX = canvas.getAttribute("data-first-position-x");

    await user.click(screen.getByRole("button", { name: "Move first position" }));
    await waitFor(() =>
      expect(canvas).toHaveAttribute("data-first-position-x", "999"),
    );
    await user.click(screen.getByRole("button", { name: "Undo last change" }));
    await waitFor(() =>
      expect(canvas).toHaveAttribute("data-first-position-x", initialX),
    );
  });

  it("saves a generated target before its transition and undoes both together", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Load starter map" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Load starter map" }));
    const canvas = screen.getByTestId("graph-canvas");
    const initialPositionCount = Number(canvas.getAttribute("data-position-count"));
    const initialTechniqueCount = Number(canvas.getAttribute("data-technique-count"));
    const repository = getGraphRepository();
    const savePosition = vi.spyOn(repository, "savePosition");
    const saveTechnique = vi.spyOn(repository, "saveTechnique");

    await user.click(screen.getByRole("button", { name: "Create transition target" }));
    await user.click(screen.getByRole("button", { name: "Submit generated transition" }));

    await waitFor(() => {
      expect(canvas).toHaveAttribute(
        "data-position-count",
        String(initialPositionCount + 1),
      );
      expect(canvas).toHaveAttribute(
        "data-technique-count",
        String(initialTechniqueCount + 1),
      );
    });
    expect(canvas).toHaveAttribute("data-last-position-name", "Butterfly Sweep");
    expect(savePosition).toHaveBeenCalledOnce();
    expect(saveTechnique).toHaveBeenCalledOnce();
    expect(savePosition.mock.invocationCallOrder[0]).toBeLessThan(
      saveTechnique.mock.invocationCallOrder[0],
    );

    await user.click(screen.getByRole("button", { name: "Undo last change" }));
    await waitFor(() => {
      expect(canvas).toHaveAttribute(
        "data-position-count",
        String(initialPositionCount),
      );
      expect(canvas).toHaveAttribute(
        "data-technique-count",
        String(initialTechniqueCount),
      );
    });
  });

  it("keeps a generated position recoverable when its transition save fails", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Load starter map" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Load starter map" }));
    const canvas = screen.getByTestId("graph-canvas");
    const initialPositionCount = Number(canvas.getAttribute("data-position-count"));
    const initialTechniqueCount = Number(canvas.getAttribute("data-technique-count"));
    vi.spyOn(getGraphRepository(), "saveTechnique").mockRejectedValueOnce(
      new Error("write failed"),
    );

    await user.click(screen.getByRole("button", { name: "Create transition target" }));
    await user.click(screen.getByRole("button", { name: "Submit generated transition" }));

    expect(
      await screen.findByText(
        /Position created, but transition could not be saved: write failed/,
      ),
    ).toBeInTheDocument();
    expect(canvas).toHaveAttribute(
      "data-position-count",
      String(initialPositionCount + 1),
    );
    expect(canvas).toHaveAttribute(
      "data-technique-count",
      String(initialTechniqueCount),
    );
    expect(canvas).toHaveAttribute("data-last-position-name", "Butterfly Sweep");

    await user.click(screen.getByRole("button", { name: "Undo last change" }));
    await waitFor(() =>
      expect(canvas).toHaveAttribute(
        "data-position-count",
        String(initialPositionCount),
      ),
    );
  });

  it("opens video import options when a macOS video is dropped on a selection", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Load starter map" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Load starter map" }));
    await user.click(screen.getByRole("button", { name: "Select map position" }));
    await waitFor(() => expect(videoDrop.listener).toBeTypeOf("function"));

    const sourcePath = "/Users/coach/Desktop/Mounted roll.MOV";
    act(() => {
      videoDrop.listener?.({ type: "enter", paths: [sourcePath] });
    });
    expect(screen.getByText("Release to import video")).toBeInTheDocument();

    act(() => {
      videoDrop.listener?.({ type: "drop", paths: [sourcePath] });
    });

    await waitFor(() =>
      expect(videoDrop.prepareVideoImportFromPath).toHaveBeenCalledWith(
        "position",
        expect.any(String),
        sourcePath,
        expect.stringMatching(/^media(?:\/|$)/),
        expect.stringMatching(/^sqlite:/),
      ),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "Video import options: Mounted roll",
      }),
    ).toBeInTheDocument();
  });

  it("makes browse, map, details, arrange, and focus reachable on mobile", async () => {
    setMobileLayout(true);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const workspace = container.querySelector(".workspace-grid");
    const inspector = screen.getByTestId("detail-inspector");

    expect(workspace).toHaveClass("workspace-grid--mobile-map");
    expect(inspector).toHaveAttribute("data-active", "false");
    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect(workspace).toHaveClass("workspace-grid--mobile-browse");
    expect(inspector).toHaveAttribute("data-active", "false");

    await user.click(screen.getByRole("button", { name: "Select browse result" }));
    expect(workspace).toHaveClass("workspace-grid--mobile-details");
    expect(inspector).toHaveAttribute("data-active", "true");

    await user.click(screen.getByRole("button", { name: "Map" }));
    expect(workspace).toHaveClass("workspace-grid--mobile-map");
    expect(inspector).toHaveAttribute("data-active", "false");
    const mobileTools = container.querySelector(".mobile-map-tools");
    expect(mobileTools).not.toBeNull();
    expect(
      mobileTools?.querySelector('[aria-label="Preview automatic layout"]'),
    ).toBeInTheDocument();
    expect(
      mobileTools?.querySelector('[aria-label="Focus selected neighborhood"]'),
    ).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Select map position" }));
    expect(workspace).toHaveClass("workspace-grid--mobile-details");
    expect(inspector).toHaveAttribute("data-active", "true");

    await user.click(screen.getByRole("button", { name: "Map" }));
    await user.click(screen.getByLabelText("Search positions and transitions"));
    expect(workspace).toHaveClass("workspace-grid--mobile-browse");
  });

  it("returns mobile secondary views to the map before requesting app exit", async () => {
    setMobileLayout(true);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const workspace = container.querySelector(".workspace-grid");

    await waitFor(() =>
      expect(
        (window as AndroidBackWindow).__ROLLMAP_HANDLE_ANDROID_BACK__,
      ).toBeTypeOf("function"),
    );
    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect(workspace).toHaveClass("workspace-grid--mobile-browse");
    expect(dispatchAndroidBack()).toBe("handled");
    expect(workspace).toHaveClass("workspace-grid--mobile-map");

    await user.click(screen.getByRole("button", { name: "Select map position" }));
    expect(workspace).toHaveClass("workspace-grid--mobile-details");
    expect(dispatchAndroidBack()).toBe("handled");
    expect(workspace).toHaveClass("workspace-grid--mobile-map");

    expect(dispatchAndroidBack()).toBe("exit");
  });

  it("closes an active media overlay before handling mobile navigation", async () => {
    setMobileLayout(true);
    const closeActiveOverlay = vi.fn(() => true);
    window.__ROLLMAP_CLOSE_ACTIVE_OVERLAY__ = closeActiveOverlay;
    render(<App />);

    await waitFor(() =>
      expect(
        (window as AndroidBackWindow).__ROLLMAP_HANDLE_ANDROID_BACK__,
      ).toBeTypeOf("function"),
    );
    expect(dispatchAndroidBack()).toBe("handled");
    expect(closeActiveOverlay).toHaveBeenCalledOnce();
  });
});