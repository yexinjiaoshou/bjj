import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { sampleGraph } from "../src/domain/sampleData";
import { TechniqueEditorDialog } from "../src/features/editor/EntityEditorDialog";
import { DetailInspector } from "../src/features/editor/DetailInspector";
import { LibrarySidebar } from "../src/features/search/LibrarySidebar";

describe("knowledge editor interactions", () => {
  it("finds a position by alias and selects it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <LibrarySidebar
        positions={sampleGraph.positions}
        techniques={sampleGraph.techniques}
        query="full guard"
        category="all"
        role="all"
        giMode="all"
        difficulty="all"
        activeTag={null}
        onCategoryChange={vi.fn()}
        onRoleChange={vi.fn()}
        onGiModeChange={vi.fn()}
        onDifficultyChange={vi.fn()}
        onTagChange={vi.fn()}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Closed Guard/i }));
    expect(onSelect).toHaveBeenCalledWith({ type: "position", id: "closed-guard" });
  });

  it("reports structured filter changes", async () => {
    const user = userEvent.setup();
    const onRoleChange = vi.fn();
    const onGiModeChange = vi.fn();
    render(
      <LibrarySidebar
        positions={sampleGraph.positions}
        techniques={sampleGraph.techniques}
        query=""
        category="all"
        role="all"
        giMode="all"
        difficulty="all"
        activeTag={null}
        onCategoryChange={vi.fn()}
        onRoleChange={onRoleChange}
        onGiModeChange={onGiModeChange}
        onDifficultyChange={vi.fn()}
        onTagChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Position role"), "top");
    await user.selectOptions(screen.getByLabelText("Gi mode"), "nogi");
    expect(onRoleChange).toHaveBeenCalledWith("top");
    expect(onGiModeChange).toHaveBeenCalledWith("nogi");
  });

  it("blocks self-loop techniques and saves a valid transition", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const source = sampleGraph.positions[0];
    const target = sampleGraph.positions[1];
    render(
      <TechniqueEditorDialog
        technique={{
          id: "new-technique",
          sourcePositionId: source.id,
          targetPositionId: source.id,
          name: "",
          description: "",
          giMode: "both",
          difficulty: "foundation",
          tags: [],
        }}
        positions={[source, target]}
        isNew
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Name"), "Guard entry");
    await user.click(screen.getByRole("button", { name: "Add transition" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText("Choose two different positions.")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("To"), target.id);
    await user.click(screen.getByRole("button", { name: "Add transition" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Guard entry",
        sourcePositionId: source.id,
        targetPositionId: target.id,
      }),
    );
  });

  it("saves a transition with an unknown destination", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const source = sampleGraph.positions[0];
    render(
      <TechniqueEditorDialog
        technique={{
          id: "unknown-technique",
          sourcePositionId: source.id,
          targetPositionId: null,
          name: "",
          description: "",
          giMode: "both",
          difficulty: "foundation",
          tags: [],
        }}
        positions={sampleGraph.positions}
        isNew
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("To")).toHaveDisplayValue(
      "Unknown (set later)",
    );
    await user.type(screen.getByLabelText("Name"), "Follow the reaction");
    await user.click(screen.getByRole("button", { name: "Add transition" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePositionId: source.id,
        targetPositionId: null,
        name: "Follow the reaction",
      }),
    );
  });

  it("starts a transition from the selected position", async () => {
    const user = userEvent.setup();
    const onAddTechnique = vi.fn();
    const source = sampleGraph.positions[0];
    render(
      <DetailInspector
        selection={{ type: "position", id: source.id }}
        positions={sampleGraph.positions}
        techniques={sampleGraph.techniques}
        attachments={[]}
        isBusy={false}
        focusSelection={false}
        onToggleFocus={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAddTechnique={onAddTechnique}
        onSelectTechnique={vi.fn()}
        onSaveAttachment={vi.fn()}
        onAddMedia={vi.fn()}
        onDeleteAttachment={vi.fn()}
        onOpenAttachment={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add transition" }));
    expect(onAddTechnique).toHaveBeenCalledWith(source.id);
  });
});