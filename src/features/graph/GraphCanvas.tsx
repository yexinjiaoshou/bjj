import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useNodesState,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
  type ReactFlowInstance,
  type XYPosition,
} from "@xyflow/react";
import type {
  GraphSelection,
  Position,
  Technique,
} from "../../domain/types";
import {
  PositionNode,
  type PositionFlowNode,
  type PositionNodeData,
} from "./PositionNode";
import {
  TechniqueEdge,
  type TechniqueFlowEdge,
} from "./TechniqueEdge";
import {
  UnknownTargetNode,
  getTargetPositionId,
  getTechniqueTargetNodeId,
  isUnknownTargetNodeId,
  type UnknownTargetFlowNode,
} from "./UnknownTargetNode";
import { getParallelEdgeOffsets } from "./parallelEdges";

interface GraphCanvasProps {
  positions: Position[];
  techniques: Technique[];
  selection: GraphSelection;
  focusSelection: boolean;
  revealRequest: number;
  readOnly?: boolean;
  onSelect: (selection: GraphSelection) => void;
  onMovePosition: (positionId: string, coordinates: XYPosition) => void;
  onConnectPositions: (
    sourcePositionId: string,
    targetPositionId: string | null,
  ) => void;
}

type GraphFlowNode = PositionFlowNode | UnknownTargetFlowNode;

interface ConnectionEndState {
  isValid: boolean | null;
  fromNode: { id: string; type?: string } | null;
  toHandle: unknown | null;
}

export function getUnresolvedConnectionSourceId(
  connectionState: ConnectionEndState,
) {
  return connectionState.isValid === null &&
    connectionState.toHandle === null &&
    connectionState.fromNode?.type === "position"
    ? connectionState.fromNode.id
    : null;
}

const nodeTypes: NodeTypes = {
  position: PositionNode,
  unknownTarget: UnknownTargetNode,
};
const edgeTypes: EdgeTypes = { technique: TechniqueEdge };

function getFocusedIds(
  selection: GraphSelection,
  techniques: Technique[],
): Set<string> | null {
  if (!selection) {
    return null;
  }

  if (selection.type === "technique") {
    const technique = techniques.find((item) => item.id === selection.id);
    return technique
      ? new Set([
          technique.sourcePositionId,
          getTechniqueTargetNodeId(
            technique.targetPositionId,
            technique.id,
          ),
        ])
      : null;
  }

  const focusedIds = new Set([selection.id]);
  techniques.forEach((technique) => {
    if (technique.sourcePositionId === selection.id) {
      focusedIds.add(
        getTechniqueTargetNodeId(
          technique.targetPositionId,
          technique.id,
        ),
      );
    }
    if (technique.targetPositionId === selection.id) {
      focusedIds.add(technique.sourcePositionId);
    }
  });
  return focusedIds;
}

export function createUnknownTargetNodes(
  positions: Position[],
  techniques: Technique[],
  focusedIds: Set<string> | null,
): UnknownTargetFlowNode[] {
  if (positions.length === 0) {
    return [];
  }

  const positionsById = new Map(
    positions.map((position) => [position.id, position]),
  );
  const unknownTargetX =
    Math.max(...positions.map((position) => position.x)) + 360;
  let previousUnknownTargetY: number | null = null;

  return techniques.flatMap((technique) => {
    if (technique.targetPositionId !== null) {
      return [];
    }

    const sourcePosition = positionsById.get(technique.sourcePositionId);
    if (!sourcePosition) {
      return [];
    }

    const id = getTechniqueTargetNodeId(null, technique.id);
    const y =
      previousUnknownTargetY === null
        ? sourcePosition.y
        : Math.max(sourcePosition.y, previousUnknownTargetY + 160);
    previousUnknownTargetY = y;

    return [{
      id,
      type: "unknownTarget" as const,
      position: { x: unknownTargetX, y },
      data: {
        isDimmed: focusedIds !== null && !focusedIds.has(id),
        unresolvedCount: 1,
      },
      draggable: false,
      selectable: false,
      deletable: false,
    }];
  });
}

function toFlowNodes(
  positions: Position[],
  focusedIds: Set<string> | null,
): PositionFlowNode[] {
  return positions.map((position) => ({
    id: position.id,
    type: "position",
    position: { x: position.x, y: position.y },
    selected: false,
    data: {
      position,
      isDimmed: focusedIds !== null && !focusedIds.has(position.id),
    },
  }));
}

export function GraphCanvas({
  positions,
  techniques,
  selection,
  focusSelection,
  revealRequest,
  readOnly = false,
  onSelect,
  onMovePosition,
  onConnectPositions,
}: GraphCanvasProps) {
  const focusedIds = useMemo(
    () => (focusSelection ? getFocusedIds(selection, techniques) : null),
    [focusSelection, selection, techniques],
  );
  const projectedNodes = useMemo(
    () => {
      const positionNodes = toFlowNodes(positions, focusedIds).map((node) => ({
        ...node,
        selected:
          selection?.type === "position" && selection.id === node.id,
      }));
      const unknownTargetNodes = createUnknownTargetNodes(
        positions,
        techniques,
        focusedIds,
      );
      return [...positionNodes, ...unknownTargetNodes];
    },
    [positions, techniques, focusedIds, selection],
  );
  const [nodes, setNodes, onNodesChange] =
    useNodesState<GraphFlowNode>(projectedNodes);
  const [flowInstance, setFlowInstance] = useState<
    ReactFlowInstance<GraphFlowNode, TechniqueFlowEdge> | null
  >(null);
  const [hoveredTechniqueId, setHoveredTechniqueId] = useState<string | null>(
    null,
  );
  const handledRevealRequest = useRef(0);

  useEffect(() => {
    setNodes(projectedNodes);
  }, [projectedNodes, setNodes]);

  const edges = useMemo<TechniqueFlowEdge[]>(() => {
    const parallelEdgeOffsets = getParallelEdgeOffsets(techniques);
    const positionsById = new Map(
      positions.map((position) => [position.id, position]),
    );

    return techniques.map((technique) => {
      const targetNodeId = getTechniqueTargetNodeId(
        technique.targetPositionId,
        technique.id,
      );
      const isConnected =
        focusedIds === null ||
        (focusedIds.has(technique.sourcePositionId) &&
          focusedIds.has(targetNodeId));
      const sourcePosition = positionsById.get(technique.sourcePositionId);
      const targetPosition = technique.targetPositionId
        ? positionsById.get(technique.targetPositionId)
        : undefined;
      const runsLeftToRight =
        !sourcePosition || !targetPosition || sourcePosition.x <= targetPosition.x;
      const isHovered = hoveredTechniqueId === technique.id;

      return {
        id: technique.id,
        source: technique.sourcePositionId,
        target: targetNodeId,
        sourceHandle: runsLeftToRight ? "right" : "left",
        targetHandle: runsLeftToRight ? "left" : "right",
        type: "technique",
        markerEnd: { type: MarkerType.ArrowClosed },
        selected:
          selection?.type === "technique" && selection.id === technique.id,
        data: {
          technique,
          isDimmed: !isConnected,
          isHovered,
          parallelOffset: parallelEdgeOffsets.get(technique.id) ?? 0,
          onSelect: () =>
            onSelect({ type: "technique", id: technique.id }),
          onHoverChange: (nextIsHovered: boolean) =>
            setHoveredTechniqueId((current) =>
              nextIsHovered
                ? technique.id
                : current === technique.id
                  ? null
                  : current,
            ),
        },
      };
    });
  }, [focusedIds, hoveredTechniqueId, onSelect, positions, selection, techniques]);

  useEffect(() => {
    if (
      !flowInstance ||
      !selection ||
      revealRequest === 0 ||
      handledRevealRequest.current === revealRequest
    ) {
      return;
    }

    const targetIds =
      selection.type === "position"
        ? [selection.id]
        : (() => {
            const technique = techniques.find((item) => item.id === selection.id);
            return technique
              ? [
                  technique.sourcePositionId,
                  getTechniqueTargetNodeId(
                    technique.targetPositionId,
                    technique.id,
                  ),
                ]
              : [];
          })();
    if (
      targetIds.length === 0 ||
      targetIds.some((id) => !flowInstance.getNode(id))
    ) {
      return;
    }

    handledRevealRequest.current = revealRequest;
    void flowInstance.fitView({
      nodes: targetIds.map((id) => ({ id })),
      padding: selection.type === "position" ? 0.8 : 0.55,
      duration: 360,
      maxZoom: 1.15,
    });
  }, [flowInstance, nodes, revealRequest, selection, techniques]);

  function handleConnect(connection: Connection) {
    if (
      connection.source &&
      !isUnknownTargetNodeId(connection.source) &&
      connection.target
    ) {
      onConnectPositions(
        connection.source,
        getTargetPositionId(connection.target),
      );
    }
  }

  function handleConnectEnd(
    _event: MouseEvent | TouchEvent,
    connectionState: ConnectionEndState,
  ) {
    const sourcePositionId = getUnresolvedConnectionSourceId(connectionState);
    if (sourcePositionId) {
      onConnectPositions(sourcePositionId, null);
    }
  }

  return (
    <div className="graph-canvas" aria-label="Jiu-jitsu position graph">
      <ReactFlow<GraphFlowNode, TechniqueFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={setFlowInstance}
        onNodesChange={onNodesChange}
        onNodeClick={(_, node) => {
          if (node.type === "position") {
            onSelect({ type: "position", id: node.id });
          }
        }}
        onEdgeClick={(_, edge) => onSelect({ type: "technique", id: edge.id })}
        onEdgeMouseEnter={(_, edge) => setHoveredTechniqueId(edge.id)}
        onEdgeMouseLeave={(_, edge) =>
          setHoveredTechniqueId((current) =>
            current === edge.id ? null : current,
          )
        }
        onPaneClick={() => onSelect(null)}
        onNodeDragStop={(_, node) => {
          if (node.type === "position") {
            onMovePosition(node.id, node.position);
          }
        }}
        onConnect={handleConnect}
        onConnectEnd={handleConnectEnd}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        connectionMode={ConnectionMode.Loose}
        minZoom={0.35}
        maxZoom={1.8}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <MiniMap
          pannable
          zoomable
          position="bottom-left"
          nodeColor={(node) => {
            if (node.type === "unknownTarget") {
              return "#9b9b93";
            }
            const category = (node.data as PositionNodeData | undefined)?.position
              .category;
            return category === "guard"
              ? "#cf5b3e"
              : category === "standing"
                ? "#326b70"
                : "#6b7354";
          }}
        />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}