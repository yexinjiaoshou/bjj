import { describe, expect, it } from "vitest";
import { sampleGraph } from "../src/domain/sampleData";
import { createAutomaticLayout } from "../src/features/graph/layout";

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
});