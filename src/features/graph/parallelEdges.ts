import type { Technique } from "../../domain/types";
import { getTechniqueTargetNodeId } from "./UnknownTargetNode";

export const PARALLEL_EDGE_SPACING = 64;

interface GroupedTechnique {
  technique: Technique;
  direction: 1 | -1;
}

export function getParallelEdgeOffsets(
  techniques: Technique[],
): Map<string, number> {
  const groups = new Map<string, GroupedTechnique[]>();

  techniques.forEach((technique) => {
    const sourceNodeId = technique.sourcePositionId;
    const targetNodeId = getTechniqueTargetNodeId(
      technique.targetPositionId,
      technique.id,
    );
    const [firstNodeId, secondNodeId] = [sourceNodeId, targetNodeId].sort();
    const key = JSON.stringify([firstNodeId, secondNodeId]);
    const group = groups.get(key) ?? [];
    group.push({
      technique,
      direction: sourceNodeId === firstNodeId ? 1 : -1,
    });
    groups.set(key, group);
  });

  const offsets = new Map<string, number>();
  groups.forEach((group) => {
    const orderedGroup = [...group].sort((left, right) =>
      left.technique.id.localeCompare(right.technique.id),
    );
    const centerIndex = (orderedGroup.length - 1) / 2;
    orderedGroup.forEach(({ technique, direction }, index) => {
      offsets.set(
        technique.id,
        (index - centerIndex) * PARALLEL_EDGE_SPACING * direction,
      );
    });
  });

  return offsets;
}