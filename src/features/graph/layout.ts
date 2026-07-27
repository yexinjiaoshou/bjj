import type { ELK, ElkNode } from "elkjs/lib/elk-api";
import type { Position, Technique } from "../../domain/types";

const NODE_WIDTH = 180;
const NODE_HEIGHT = 82;
const LAYOUT_MARGIN = 72;

let layoutEngine: Promise<ELK> | null = null;

function getLayoutEngine() {
  layoutEngine ??= import("elkjs/lib/elk.bundled.js").then(
    ({ default: ElkConstructor }) => new ElkConstructor(),
  );
  return layoutEngine;
}

export async function createAutomaticLayout(
  positions: Position[],
  techniques: Technique[],
): Promise<Position[]> {
  if (positions.length < 2) {
    return positions.map((position) => ({ ...position }));
  }

  const positionIds = new Set(positions.map((position) => position.id));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "SPLINES",
      "elk.separateConnectedComponents": "true",
      "elk.spacing.componentComponent": "140",
      "elk.spacing.nodeNode": "84",
      "elk.layered.spacing.nodeNodeBetweenLayers": "180",
      "elk.layered.spacing.edgeNodeBetweenLayers": "64",
      "elk.layered.spacing.edgeEdgeBetweenLayers": "32",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.layered.layering.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: positions.map((position) => ({
      id: position.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    edges: techniques
      .filter(
        (
          technique,
        ): technique is Technique & { targetPositionId: string } =>
          positionIds.has(technique.sourcePositionId) &&
          technique.targetPositionId !== null &&
          positionIds.has(technique.targetPositionId) &&
          technique.sourcePositionId !== technique.targetPositionId,
      )
      .map((technique) => ({
        id: technique.id,
        sources: [technique.sourcePositionId],
        targets: [technique.targetPositionId],
      })),
  };

  const result = await (await getLayoutEngine()).layout(graph);
  const layoutNodes = result.children ?? [];
  if (
    layoutNodes.length !== positions.length ||
    layoutNodes.some((node) => !Number.isFinite(node.x) || !Number.isFinite(node.y))
  ) {
    throw new Error("Automatic layout did not position every node");
  }

  const minimumX = Math.min(...layoutNodes.map((node) => node.x as number));
  const minimumY = Math.min(...layoutNodes.map((node) => node.y as number));
  const nodesById = new Map(layoutNodes.map((node) => [node.id, node]));

  return positions.map((position) => {
    const node = nodesById.get(position.id);
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      throw new Error(`Automatic layout omitted position ${position.id}`);
    }
    return {
      ...position,
      x: Math.round((node.x as number) - minimumX + LAYOUT_MARGIN),
      y: Math.round((node.y as number) - minimumY + LAYOUT_MARGIN),
    };
  });
}