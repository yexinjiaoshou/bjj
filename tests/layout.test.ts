import { describe, expect, it } from "vitest";
import { sampleGraph } from "../src/domain/sampleData";
import {
  createAutomaticLayout,
  placeNewTargetPosition,
} from "../src/features/graph/layout";
import type { Position, Technique } from "../src/domain/types";

function makePosition(id: string, x: number, y: number): Position {
  return {
    id,
    name: id,
    aliases: [],
    description: "",
    category: "guard",
    role: "bottom",
    tags: [],
    x,
    y,
  };
}

function makeTechnique(sourcePositionId: string, targetPositionId: string): Technique {
  return {
    id: `${sourcePositionId}-${targetPositionId}`,
    sourcePositionId,
    targetPositionId,
    name: "Transition",
    description: "",
    giMode: "both",
    difficulty: "foundation",
    tags: [],
  };
}

describe("automatic layout", () => {
  it("returns finite normalized coordinates without mutating the graph", async () => {
    const originalCoordinates = sampleGraph.positions.map(({ id, x, y }) => ({ id, x, y }));
    const layout = await createAutomaticLayout(sampleGraph.positions, sampleGraph.techniques);

    expect(sampleGraph.positions.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      originalCoordinates,
    );
    expect(layout.map((position) => position.id)).toEqual(
      sampleGraph.positions.map((position) => position.id),
    );
    expect(layout.every((position) => Number.isFinite(position.x) && Number.isFinite(position.y)))
      .toBe(true);
    expect(Math.min(...layout.map((position) => position.x))).toBe(72);
    expect(Math.min(...layout.map((position) => position.y))).toBe(72);
    expect(layout.some((position, index) => position.x !== originalCoordinates[index].x)).toBe(
      true,
    );

    const positionsById = new Map(layout.map((position) => [position.id, position]));
    const leftToRightTechniques = sampleGraph.techniques.filter((technique) => {
      const source = positionsById.get(technique.sourcePositionId);
      const target = positionsById.get(technique.targetPositionId);
      return source && target && source.x < target.x;
    });
    expect(leftToRightTechniques.length).toBeGreaterThanOrEqual(5);
  });

  it("produces a repeatable result for the same graph", async () => {
    const firstLayout = await createAutomaticLayout(
      sampleGraph.positions,
      sampleGraph.techniques,
    );
    const secondLayout = await createAutomaticLayout(
      sampleGraph.positions,
      sampleGraph.techniques,
    );
    expect(firstLayout).toEqual(secondLayout);
  });

  it("lays out real positions while an unresolved transition is present", async () => {
    const unresolved = {
      ...sampleGraph.techniques[0],
      id: "unresolved-transition",
      targetPositionId: null,
    };
    const layout = await createAutomaticLayout(sampleGraph.positions, [
      ...sampleGraph.techniques,
      unresolved,
    ]);

    expect(layout).toHaveLength(sampleGraph.positions.length);
    expect(
      layout.every(
        (position) => Number.isFinite(position.x) && Number.isFinite(position.y),
      ),
    ).toBe(true);
  });

  it("uses the ELK target offset without moving existing positions", async () => {
    const source = makePosition("source", 840, 460);
    const target = makePosition("target", 0, 0);
    const technique = makeTechnique(source.id, target.id);
    const originalSource = { ...source };
    const elkLayout = await createAutomaticLayout(
      [source, target],
      [technique],
    );
    const elkSource = elkLayout.find((position) => position.id === source.id)!;
    const elkTarget = elkLayout.find((position) => position.id === target.id)!;

    const placedTarget = await placeNewTargetPosition(
      [source],
      [],
      target,
      technique,
    );

    expect(source).toEqual(originalSource);
    expect(placedTarget.x - source.x).toBe(elkTarget.x - elkSource.x);
    expect(placedTarget.y - source.y).toBe(elkTarget.y - elkSource.y);
  });

  it("moves the new target to a deterministic free slot when ELK overlaps a node", async () => {
    const source = makePosition("source", 500, 500);
    const target = makePosition("target", 0, 0);
    const technique = makeTechnique(source.id, target.id);
    const initialTarget = await placeNewTargetPosition(
      [source],
      [],
      target,
      technique,
    );
    const blocker = makePosition("blocker", initialTarget.x, initialTarget.y);

    const firstPlacement = await placeNewTargetPosition(
      [source, blocker],
      [],
      target,
      technique,
    );
    const secondPlacement = await placeNewTargetPosition(
      [source, blocker],
      [],
      target,
      technique,
    );

    expect(firstPlacement).toEqual(secondPlacement);
    expect(firstPlacement).not.toMatchObject({ x: blocker.x, y: blocker.y });
    expect(
      firstPlacement.x + 180 <= blocker.x ||
        blocker.x + 180 <= firstPlacement.x ||
        firstPlacement.y + 82 <= blocker.y ||
        blocker.y + 82 <= firstPlacement.y,
    ).toBe(true);
  });
});