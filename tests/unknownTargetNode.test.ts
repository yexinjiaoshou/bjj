import { describe, expect, it } from "vitest";
import { sampleGraph } from "../src/domain/sampleData";
import { createUnknownTargetNodes } from "../src/features/graph/GraphCanvas";
import {
  UNKNOWN_TARGET_NODE_ID,
  getTargetPositionId,
  getTechniqueTargetNodeId,
} from "../src/features/graph/UnknownTargetNode";

describe("virtual unknown target", () => {
  it("maps each unresolved technique to its own virtual node", () => {
    expect(getTechniqueTargetNodeId(null, "technique-a")).toBe(
      `${UNKNOWN_TARGET_NODE_ID}:technique-a`,
    );
    expect(getTechniqueTargetNodeId(null, "technique-b")).toBe(
      `${UNKNOWN_TARGET_NODE_ID}:technique-b`,
    );
    expect(
      getTargetPositionId(`${UNKNOWN_TARGET_NODE_ID}:technique-a`),
    ).toBeNull();
  });

  it("leaves real position IDs unchanged", () => {
    expect(getTechniqueTargetNodeId("side-control", "technique-a")).toBe(
      "side-control",
    );
    expect(getTargetPositionId("side-control")).toBe("side-control");
  });

  it("does not show an unknown node without an unresolved technique", () => {
    const nodes = createUnknownTargetNodes(
      sampleGraph.positions,
      sampleGraph.techniques,
      null,
    );

    expect(nodes).toEqual([]);
  });

  it("creates one virtual node for each unresolved technique", () => {
    const source = sampleGraph.positions[0];
    const unresolved = sampleGraph.techniques.slice(0, 2).map((technique) => ({
      ...technique,
      sourcePositionId: source.id,
      targetPositionId: null,
    }));
    const focusedUnknownId = `${UNKNOWN_TARGET_NODE_ID}:${unresolved[0].id}`;
    const nodes = createUnknownTargetNodes(
      sampleGraph.positions,
      unresolved,
      new Set([source.id, focusedUnknownId]),
    );

    expect(nodes).toHaveLength(2);
    expect(nodes.map((node) => node.id)).toEqual(
      unresolved.map(
        (technique) => `${UNKNOWN_TARGET_NODE_ID}:${technique.id}`,
      ),
    );
    expect(new Set(nodes.map((node) => node.position.y)).size).toBe(2);
    expect(nodes[0].data.isDimmed).toBe(false);
    expect(nodes[1].data.isDimmed).toBe(true);
  });

  it("removes a virtual node when its technique no longer exists", () => {
    const unresolved = sampleGraph.techniques.slice(0, 2).map((technique) => ({
      ...technique,
      targetPositionId: null,
    }));

    const nodes = createUnknownTargetNodes(
      sampleGraph.positions,
      unresolved,
      null,
    );
    const remainingNodes = createUnknownTargetNodes(
      sampleGraph.positions,
      unresolved.slice(1),
      null,
    );

    expect(nodes).toHaveLength(2);
    expect(remainingNodes).toHaveLength(1);
    expect(remainingNodes[0].id).toBe(
      `${UNKNOWN_TARGET_NODE_ID}:${unresolved[1].id}`,
    );
  });
});