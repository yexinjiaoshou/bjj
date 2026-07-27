import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/features/graph/GraphCanvas", () => ({
  GraphCanvas: ({
    onSelect,
  }: {
    onSelect: (selection: { type: "position"; id: string }) => void;
  }) => (
    <div data-testid="graph-canvas">
      <button
        type="button"
        onClick={() => onSelect({ type: "position", id: "map-position" })}
      >
        Select map position
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
  DetailInspector: () => <aside data-testid="detail-inspector" />,
}));
vi.mock("../src/features/editor/EntityEditorDialog", () => ({
  PositionEditorDialog: () => null,
  TechniqueEditorDialog: () => null,
}));

import App from "../src/App";

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

  it("makes browse, map, details, arrange, and focus reachable on mobile", async () => {
    setMobileLayout(true);
    const user = userEvent.setup();
    const { container } = render(<App />);
    const workspace = container.querySelector(".workspace-grid");

    expect(workspace).toHaveClass("workspace-grid--mobile-map");
    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect(workspace).toHaveClass("workspace-grid--mobile-browse");

    await user.click(screen.getByRole("button", { name: "Select browse result" }));
    expect(workspace).toHaveClass("workspace-grid--mobile-details");

    await user.click(screen.getByRole("button", { name: "Map" }));
    expect(workspace).toHaveClass("workspace-grid--mobile-map");
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