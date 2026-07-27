import { describe, expect, it } from "vitest";
import { sampleGraph } from "../src/domain/sampleData";
import { filterGraph, type GraphFilters } from "../src/features/search/filterGraph";

const allFilters: GraphFilters = {
  category: "all",
  role: "all",
  giMode: "all",
  difficulty: "all",
  tag: null,
};

describe("knowledge graph filters", () => {
  it("combines position category and role filters", () => {
    const result = filterGraph(sampleGraph, {
      ...allFilters,
      category: "guard",
      role: "bottom",
    });

    expect(result.positions.map((position) => position.id)).toEqual([
      "closed-guard",
      "half-guard",
    ]);
    expect(result.techniques).toEqual([]);
  });

  it("combines Gi compatibility with exact difficulty", () => {
    const result = filterGraph(sampleGraph, {
      ...allFilters,
      giMode: "gi",
      difficulty: "intermediate",
    });

    expect(result.techniques.map((technique) => technique.id)).toEqual(["knee-cut"]);
  });

  it("keeps both endpoints of a technique selected by tag", () => {
    const result = filterGraph(sampleGraph, { ...allFilters, tag: "pressure" });

    expect(result.positions.map((position) => position.id)).toEqual([
      "half-guard",
      "side-control",
    ]);
    expect(result.techniques.map((technique) => technique.id)).toEqual(["knee-cut"]);
  });

  it("does not mutate the source graph", () => {
    filterGraph(sampleGraph, { ...allFilters, category: "guard" });
    expect(sampleGraph.positions).toHaveLength(6);
    expect(sampleGraph.techniques).toHaveLength(7);
  });

  it("keeps an unresolved transition when its source position is visible", () => {
    const unresolved = {
      ...sampleGraph.techniques[0],
      id: "unresolved-transition",
      sourcePositionId: "closed-guard",
      targetPositionId: null,
      tags: ["reaction"],
    };
    const result = filterGraph(
      { ...sampleGraph, techniques: [...sampleGraph.techniques, unresolved] },
      { ...allFilters, category: "guard", role: "bottom" },
    );

    expect(result.techniques).toContainEqual(unresolved);
  });
});