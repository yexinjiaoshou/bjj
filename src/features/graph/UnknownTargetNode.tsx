import {
  Handle,
  Position as HandlePosition,
  type Node,
  type NodeProps,
} from "@xyflow/react";

export const UNKNOWN_TARGET_NODE_ID = "rollmap:unknown-target";
const UNKNOWN_TARGET_NODE_ID_PREFIX = `${UNKNOWN_TARGET_NODE_ID}:`;

export function getTechniqueTargetNodeId(
  targetPositionId: string | null,
  techniqueId: string,
) {
  return targetPositionId ?? `${UNKNOWN_TARGET_NODE_ID_PREFIX}${techniqueId}`;
}

export function isUnknownTargetNodeId(nodeId: string) {
  return (
    nodeId === UNKNOWN_TARGET_NODE_ID ||
    nodeId.startsWith(UNKNOWN_TARGET_NODE_ID_PREFIX)
  );
}

export function getTargetPositionId(targetNodeId: string) {
  return isUnknownTargetNodeId(targetNodeId) ? null : targetNodeId;
}

export interface UnknownTargetNodeData extends Record<string, unknown> {
  isDimmed: boolean;
  unresolvedCount: number;
}

export type UnknownTargetFlowNode = Node<UnknownTargetNodeData, "unknownTarget">;

export function UnknownTargetNode({ data }: NodeProps<UnknownTargetFlowNode>) {
  return (
    <article
      className={`position-node position-node--unknown${data.isDimmed ? " is-dimmed" : ""}`}
    >
      <Handle
        id="left"
        type="target"
        position={HandlePosition.Left}
        className="position-node__handle"
        isConnectableStart={false}
      />
      <div className="position-node__meta">
        <span className="position-node__category">Unresolved</span>
        <span className="position-node__role">
          {data.unresolvedCount > 0 ? data.unresolvedCount : "—"}
        </span>
      </div>
      <strong>Unknown</strong>
      <div className="position-node__tags">
        <span>Destination</span>
      </div>
      <Handle
        id="right"
        type="target"
        position={HandlePosition.Right}
        className="position-node__handle"
        isConnectableStart={false}
      />
    </article>
  );
}