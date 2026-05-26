"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import { resolveAvatarUrl } from "@/lib/api";
import type { FounderVisibleAgent } from "@/lib/types";

// ─── Node data shape ─────────────────────────────────────────────

interface AgentNodeData extends Record<string, unknown> {
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: "free" | "working" | "paused";
}

type AgentNodeType = Node<AgentNodeData, "agentNode">;

// ─── Status colors ───────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  free: "bg-green-500",
  working: "bg-amber-500",
  paused: "bg-gray-400",
};

const STATUS_LABEL: Record<string, string> = {
  free: "Free",
  working: "Working",
  paused: "Paused",
};

// ─── Custom AgentNode ────────────────────────────────────────────

function AgentNode({ data }: NodeProps<AgentNodeType>) {
  const dotClass = STATUS_DOT[data.status] ?? "bg-gray-400";
  const label = STATUS_LABEL[data.status] ?? "Unknown";

  return (
    <div className="rounded-none border border-border bg-background px-4 py-3 shadow-sm min-w-[180px] max-w-[220px]">
      <Handle type="target" position={Position.Top} className="!bg-border !w-2 !h-2" />

      <div className="flex items-center gap-2.5">
        {/* Avatar */}
        <div className="relative shrink-0">
          <div className="h-8 w-8 rounded-none bg-secondary flex items-center justify-center overflow-hidden ring-1 ring-border">
            {data.icon ? (
              <img
                src={resolveAvatarUrl(data.icon)}
                alt={data.name}
                className="h-8 w-8 rounded-none object-cover"
              />
            ) : (
              <span className="text-xs font-semibold text-muted-foreground">
                {data.name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          {/* Status dot */}
          <div className="absolute -bottom-0.5 -right-0.5">
            <div
              className={`h-2.5 w-2.5 rounded-none border-2 border-background ${dotClass}`}
              title={label}
            />
            {data.status === "working" && (
              <div
                className={`absolute inset-0 h-2.5 w-2.5 rounded-none ${dotClass} animate-ping opacity-40`}
              />
            )}
          </div>
        </div>

        {/* Name + role */}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold leading-tight truncate">{data.name}</div>
          <div className="text-[10px] text-muted-foreground leading-tight truncate">
            {data.title || data.role}
          </div>
        </div>
      </div>

      {/* Status label */}
      <div className="mt-2">
        <span className="text-[10px] text-muted-foreground">{label}</span>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-border !w-2 !h-2" />
    </div>
  );
}

// ─── Dagre layout ────────────────────────────────────────────────

const NODE_WIDTH = 200;
const NODE_HEIGHT = 90;

function applyDagreLayout(nodes: AgentNodeType[], edges: Edge[]): AgentNodeType[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return {
      ...node,
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
    };
  });
}

// ─── Build helpers (pure, testable) ──────────────────────────────

export function buildOrgNodes(
  agents: FounderVisibleAgent[],
): AgentNodeType[] {
  return agents.map((agent) => ({
    id: agent.id,
    type: "agentNode" as const,
    position: { x: 0, y: 0 },
    data: {
      name: agent.name,
      role: agent.role,
      title: agent.title,
      icon: agent.icon,
      status: agent.status,
    },
  }));
}

export function buildOrgEdges(agents: FounderVisibleAgent[]): Edge[] {
  const agentIds = new Set(agents.map((a) => a.id));
  return agents
    .filter((a) => a.reports_to && agentIds.has(a.reports_to))
    .map((a) => ({
      id: `edge-${a.id}-${a.reports_to}`,
      source: a.reports_to as string,
      target: a.id,
      type: "smoothstep" as const,
      animated: a.status === "working",
    }));
}

// ─── Node types registry ─────────────────────────────────────────

const nodeTypes = { agentNode: AgentNode };

// ─── OrgChart component ──────────────────────────────────────────

export function OrgChart({
  agents,
  onAgentClick,
}: {
  agents: FounderVisibleAgent[];
  onAgentClick?: (agentId: string) => void;
}) {
  const rawNodes = useMemo(() => buildOrgNodes(agents), [agents]);
  const rawEdges = useMemo(() => buildOrgEdges(agents), [agents]);
  const layoutNodes = useMemo(() => applyDagreLayout(rawNodes, rawEdges), [rawNodes, rawEdges]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rawEdges);

  // Sync layout when data changes
  useEffect(() => {
    setNodes(layoutNodes);
    setEdges(rawEdges);
  }, [layoutNodes, rawEdges, setNodes, setEdges]);

  const onInit = useCallback((instance: { fitView: () => void }) => {
    instance.fitView();
  }, []);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: AgentNodeType) => {
      onAgentClick?.(node.id);
    },
    [onAgentClick],
  );

  if (agents.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center dot-grid">
        <p className="text-sm text-muted-foreground">No agents in this team yet.</p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onInit={onInit}
        onNodeClick={handleNodeClick}
        fitView
        minZoom={0.3}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        style={{ background: "transparent" }}
      />
    </div>
  );
}
