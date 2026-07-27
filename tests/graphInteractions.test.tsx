import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Position as HandlePosition,
  ReactFlowProvider,
  type EdgeProps,
} from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import type { Technique } from "../src/domain/types";
import { getUnresolvedConnectionSourceId } from "../src/features/graph/GraphCanvas";
import {
  TECHNIQUE_EDGE_INTERACTION_WIDTH,
  TechniqueEdge,
  TechniqueEdgeLabel,
  type TechniqueFlowEdge,
} from "../src/features/graph/TechniqueEdge";

const technique: Technique = {
  id: "sweep",
  sourcePositionId: "guard",
  targetPositionId: "mount",
  name: "Hip Bump Sweep",
  description: "",
  giMode: "both",
  difficulty: "foundation",
  tags: [],
};

describe("graph object interactions", () => {
  it("creates an unresolved transition when a position connection ends on blank canvas", () => {
    expect(
      getUnresolvedConnectionSourceId({
        isValid: null,
        fromNode: { id: "guard", type: "position" },
        toHandle: null,
      }),
    ).toBe("guard");
  });

  it("does not create an unresolved transition for other connection endings", () => {
    expect(
      getUnresolvedConnectionSourceId({
        isValid: true,
        fromNode: { id: "guard", type: "position" },
        toHandle: { nodeId: "mount" },
      }),
    ).toBeNull();
    expect(
      getUnresolvedConnectionSourceId({
        isValid: false,
        fromNode: { id: "guard", type: "position" },
        toHandle: { nodeId: "guard" },
      }),
    ).toBeNull();
    expect(
      getUnresolvedConnectionSourceId({
        isValid: null,
        fromNode: { id: "rollmap:unknown-target:sweep", type: "unknownTarget" },
        toHandle: null,
      }),
    ).toBeNull();
  });

  it("gives transition edges a wide invisible hit target", () => {
    const edgeProps: EdgeProps<TechniqueFlowEdge> = {
      id: technique.id,
      type: "technique",
      source: "guard",
      target: "mount",
      sourceX: 0,
      sourceY: 0,
      targetX: 300,
      targetY: 0,
      sourcePosition: HandlePosition.Right,
      targetPosition: HandlePosition.Left,
      selected: false,
      animated: false,
      selectable: true,
      deletable: true,
      data: {
        technique,
        isDimmed: false,
        isHovered: true,
        parallelOffset: 0,
        onSelect: vi.fn(),
        onHoverChange: vi.fn(),
      },
    };
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <TechniqueEdge {...edgeProps} />
        </svg>
      </ReactFlowProvider>,
    );

    expect(TECHNIQUE_EDGE_INTERACTION_WIDTH).toBeGreaterThanOrEqual(44);
    expect(
      container.querySelector(".react-flow__edge-interaction"),
    ).toHaveAttribute(
      "stroke-width",
      String(TECHNIQUE_EDGE_INTERACTION_WIDTH),
    );
    expect(container.querySelector(".technique-edge")).toHaveClass(
      "is-hovered",
    );
  });

  it("selects a transition directly from its label", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onHoverChange = vi.fn();
    render(
      <TechniqueEdgeLabel
        technique={technique}
        labelX={150}
        labelY={32}
        selected={false}
        isDimmed={false}
        isHovered={false}
        onSelect={onSelect}
        onHoverChange={onHoverChange}
      />,
    );

    const label = screen.getByRole("button", {
      name: "Select transition Hip Bump Sweep",
    });
    await user.tab();
    expect(label).toHaveFocus();
    expect(onHoverChange).toHaveBeenLastCalledWith(true);

    await user.hover(label);
    expect(onHoverChange).toHaveBeenLastCalledWith(true);

    await user.click(label);
    expect(onSelect).toHaveBeenCalledOnce();

    await user.unhover(label);
    expect(onHoverChange).toHaveBeenLastCalledWith(false);
  });
});