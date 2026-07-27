import { Position as HandlePosition } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { Position, Technique } from "../src/domain/types";
import { getTechniqueEdgePath } from "../src/features/graph/TechniqueEdge";
import { createAutomaticLayout } from "../src/features/graph/layout";
import {
  PARALLEL_EDGE_SPACING,
  getParallelEdgeOffsets,
} from "../src/features/graph/parallelEdges";

function technique(
  id: string,
  sourcePositionId = "a",
  targetPositionId: string | null = "b",
): Technique {
  return {
    id,
    sourcePositionId,
    targetPositionId,
    name: id,
    description: "",
    giMode: "both",
    difficulty: "foundation",
    tags: [],
  };
}

function position(id: string): Position {
  return {
    id,
    name: id,
    aliases: [],
    description: "",
    category: "control",
    role: "top",
    tags: [],
    x: 0,
    y: 0,
  };
}

describe("parallel technique routing", () => {
  it("assigns stable symmetric lanes to techniques with the same endpoints", () => {
    const offsets = getParallelEdgeOffsets([
      technique("second"),
      technique("first"),
    ]);

    expect(offsets.get("first")).toBe(-PARALLEL_EDGE_SPACING / 2);
    expect(offsets.get("second")).toBe(PARALLEL_EDGE_SPACING / 2);
    expect(getParallelEdgeOffsets([technique("only")]).get("only")).toBe(0);
  });

  it("separates opposite directions sharing the same position pair", () => {
    const offsets = getParallelEdgeOffsets([
      technique("forward", "a", "b"),
      technique("reverse", "b", "a"),
    ]);
    const forwardOffset = offsets.get("forward") as number;
    const reverseOffset = offsets.get("reverse") as number;

    const [, , forwardLabelY] = getTechniqueEdgePath({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: HandlePosition.Right,
      targetX: 300,
      targetY: 0,
      targetPosition: HandlePosition.Left,
      parallelOffset: forwardOffset,
    });
    const [, , reverseLabelY] = getTechniqueEdgePath({
      sourceX: 300,
      sourceY: 0,
      sourcePosition: HandlePosition.Left,
      targetX: 0,
      targetY: 0,
      targetPosition: HandlePosition.Right,
      parallelOffset: reverseOffset,
    });

    expect(forwardLabelY).toBe(-PARALLEL_EDGE_SPACING / 2);
    expect(reverseLabelY).toBe(PARALLEL_EDGE_SPACING / 2);
  });

  it("routes same-direction labels and curves on opposite sides", () => {
    const [firstPath, , firstLabelY] = getTechniqueEdgePath({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: HandlePosition.Right,
      targetX: 300,
      targetY: 0,
      targetPosition: HandlePosition.Left,
      parallelOffset: -PARALLEL_EDGE_SPACING / 2,
    });
    const [secondPath, , secondLabelY] = getTechniqueEdgePath({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: HandlePosition.Right,
      targetX: 300,
      targetY: 0,
      targetPosition: HandlePosition.Left,
      parallelOffset: PARALLEL_EDGE_SPACING / 2,
    });

    expect(firstPath).not.toBe(secondPath);
    expect(firstLabelY).toBe(-PARALLEL_EDGE_SPACING / 2);
    expect(secondLabelY).toBe(PARALLEL_EDGE_SPACING / 2);
  });

  it("keeps duplicate transitions separated after automatic layout", async () => {
    const techniques = [technique("first"), technique("second")];
    const layout = await createAutomaticLayout(
      [position("a"), position("b")],
      techniques,
    );
    const source = layout.find(({ id }) => id === "a") as Position;
    const target = layout.find(({ id }) => id === "b") as Position;
    const offsets = getParallelEdgeOffsets(techniques);
    const paths = techniques.map(({ id }) =>
      getTechniqueEdgePath({
        sourceX: source.x + 180,
        sourceY: source.y + 41,
        sourcePosition: HandlePosition.Right,
        targetX: target.x,
        targetY: target.y + 41,
        targetPosition: HandlePosition.Left,
        parallelOffset: offsets.get(id) as number,
      }),
    );

    expect(paths[0][0]).not.toBe(paths[1][0]);
    expect(Math.abs(paths[0][2] - paths[1][2])).toBe(
      PARALLEL_EDGE_SPACING,
    );
  });
});