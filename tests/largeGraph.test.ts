import { describe, expect, it } from "vitest";
import { createAutomaticLayout } from "../src/features/graph/layout";
import { filterGraph } from "../src/features/search/filterGraph";
import { createLargeGraph } from "./fixtures/largeGraph";

describe("large knowledge graph", () => {
  it("filters and lays out 200 positions with 500 transitions", async () => {
    const graph = createLargeGraph();
    const originalCoordinates = graph.positions.map(({ x, y }) => ({ x, y }));

    const filtered = filterGraph(graph, {
      category: "all",
      role: "all",
      giMode: "nogi",
      difficulty: "advanced",
      tag: null,
    });
    const layout = await createAutomaticLayout(graph.positions, graph.techniques);

    expect(graph.positions).toHaveLength(200);
    expect(graph.techniques).toHaveLength(500);
    expect(filtered.techniques.length).toBeGreaterThan(0);
    expect(
      filtered.techniques.every(
        (technique) =>
          technique.difficulty === "advanced" &&
          (technique.giMode === "nogi" || technique.giMode === "both"),
      ),
    ).toBe(true);
    expect(layout).toHaveLength(200);
    expect(layout.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
    expect(graph.positions.map(({ x, y }) => ({ x, y }))).toEqual(originalCoordinates);
  }, 10_000);
});