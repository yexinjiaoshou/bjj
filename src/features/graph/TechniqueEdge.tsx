import {
  BaseEdge,
  EdgeLabelRenderer,
  Position as HandlePosition,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import type { Technique } from "../../domain/types";

export interface TechniqueEdgeData extends Record<string, unknown> {
  technique: Technique;
  isDimmed: boolean;
  isHovered: boolean;
  parallelOffset: number;
  onSelect: () => void;
  onHoverChange: (isHovered: boolean) => void;
}

export type TechniqueFlowEdge = Edge<TechniqueEdgeData, "technique">;

const giModeLabels: Record<Technique["giMode"], string> = {
  gi: "Gi",
  nogi: "No-Gi",
  both: "Both",
};

export const TECHNIQUE_EDGE_INTERACTION_WIDTH = 48;

interface TechniqueEdgePathOptions {
  sourceX: number;
  sourceY: number;
  sourcePosition: HandlePosition;
  targetX: number;
  targetY: number;
  targetPosition: HandlePosition;
  parallelOffset: number;
}

function getHandleDirection(position: HandlePosition) {
  switch (position) {
    case HandlePosition.Left:
      return { x: -1, y: 0 };
    case HandlePosition.Right:
      return { x: 1, y: 0 };
    case HandlePosition.Top:
      return { x: 0, y: -1 };
    case HandlePosition.Bottom:
      return { x: 0, y: 1 };
  }
}

export function getTechniqueEdgePath({
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  parallelOffset,
}: TechniqueEdgePathOptions): [string, number, number] {
  if (parallelOffset === 0) {
    const [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      curvature: 0.22,
    });
    return [path, labelX, labelY];
  }

  const deltaX = targetX - sourceX;
  const deltaY = targetY - sourceY;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance === 0) {
    const [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      curvature: 0.22,
    });
    return [path, labelX, labelY];
  }

  const directionX = deltaX / distance;
  const directionY = deltaY / distance;
  const normalX = -directionY;
  const normalY = directionX;
  const labelX = (sourceX + targetX) / 2 + normalX * parallelOffset;
  const labelY = (sourceY + targetY) / 2 + normalY * parallelOffset;
  const endpointControlDistance = Math.min(120, Math.max(44, distance * 0.24));
  const midpointControlDistance = Math.min(90, Math.max(28, distance * 0.18));
  const sourceDirection = getHandleDirection(sourcePosition);
  const targetDirection = getHandleDirection(targetPosition);
  const sourceControlX = sourceX + sourceDirection.x * endpointControlDistance;
  const sourceControlY = sourceY + sourceDirection.y * endpointControlDistance;
  const beforeMidpointX = labelX - directionX * midpointControlDistance;
  const beforeMidpointY = labelY - directionY * midpointControlDistance;
  const afterMidpointX = labelX + directionX * midpointControlDistance;
  const afterMidpointY = labelY + directionY * midpointControlDistance;
  const targetControlX = targetX + targetDirection.x * endpointControlDistance;
  const targetControlY = targetY + targetDirection.y * endpointControlDistance;

  return [
    `M${sourceX},${sourceY} C${sourceControlX},${sourceControlY} ${beforeMidpointX},${beforeMidpointY} ${labelX},${labelY} C${afterMidpointX},${afterMidpointY} ${targetControlX},${targetControlY} ${targetX},${targetY}`,
    labelX,
    labelY,
  ];
}

interface TechniqueEdgeLabelProps {
  technique: Technique;
  labelX: number;
  labelY: number;
  selected: boolean;
  isDimmed: boolean;
  isHovered: boolean;
  onSelect: () => void;
  onHoverChange: (isHovered: boolean) => void;
}

export function TechniqueEdgeLabel({
  technique,
  labelX,
  labelY,
  selected,
  isDimmed,
  isHovered,
  onSelect,
  onHoverChange,
}: TechniqueEdgeLabelProps) {
  return (
    <button
      type="button"
      className={`technique-edge__label nodrag nopan${selected ? " is-selected" : ""}${isDimmed ? " is-dimmed" : ""}${isHovered ? " is-hovered" : ""}`}
      style={{
        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px) scale(${isHovered ? 1.04 : 1})`,
      }}
      aria-label={`Select transition ${technique.name}`}
      title={`Select ${technique.name}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      onFocus={() => onHoverChange(true)}
      onBlur={() => onHoverChange(false)}
    >
      <strong>{technique.name}</strong>
      <span>{giModeLabels[technique.giMode]}</span>
    </button>
  );
}

export function TechniqueEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<TechniqueFlowEdge>) {
  const [edgePath, labelX, labelY] = getTechniqueEdgePath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    parallelOffset: data?.parallelOffset ?? 0,
  });

  const isDimmed = data?.isDimmed ?? false;
  const isHovered = data?.isHovered ?? false;
  const technique = data?.technique;

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={TECHNIQUE_EDGE_INTERACTION_WIDTH}
        className={`technique-edge${selected ? " is-selected" : ""}${isDimmed ? " is-dimmed" : ""}${isHovered ? " is-hovered" : ""}`}
      />
      {technique && (
        <EdgeLabelRenderer>
          <TechniqueEdgeLabel
            technique={technique}
            labelX={labelX}
            labelY={labelY}
            selected={Boolean(selected)}
            isDimmed={isDimmed}
            isHovered={isHovered}
            onSelect={data?.onSelect ?? (() => undefined)}
            onHoverChange={data?.onHoverChange ?? (() => undefined)}
          />
        </EdgeLabelRenderer>
      )}
    </>
  );
}