import {
  Handle,
  Position as HandlePosition,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { Position } from "../../domain/types";

export interface PositionNodeData extends Record<string, unknown> {
  position: Position;
  isDimmed: boolean;
}

export type PositionFlowNode = Node<PositionNodeData, "position">;

const categoryLabels: Record<Position["category"], string> = {
  standing: "Standing",
  guard: "Guard",
  control: "Control",
  submission: "Submission",
};

export function PositionNode({ data, selected }: NodeProps<PositionFlowNode>) {
  const { position, isDimmed } = data;

  return (
    <article
      className={`position-node position-node--${position.category}${selected ? " is-selected" : ""}${isDimmed ? " is-dimmed" : ""}`}
    >
      <Handle
        id="left"
        type="source"
        position={HandlePosition.Left}
        className="position-node__handle"
      />
      <div className="position-node__meta">
        <span className="position-node__category">
          {categoryLabels[position.category]}
        </span>
        <span className={`position-node__role position-node__role--${position.role}`}>
          {position.role}
        </span>
      </div>
      <strong>{position.name}</strong>
      <div className="position-node__tags">
        {position.tags.slice(0, 2).map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <Handle
        id="right"
        type="source"
        position={HandlePosition.Right}
        className="position-node__handle"
      />
    </article>
  );
}