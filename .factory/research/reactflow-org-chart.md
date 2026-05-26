# ReactFlow Org Chart — Research & Patterns

> Researched 2026-03-28 from official ReactFlow docs (reactflow.dev), npm, and community examples.

---

## 1. Package List

| Package | Version | Purpose |
|---|---|---|
| `@xyflow/react` | `^12.10.2` | Core React Flow library (nodes, edges, viewport, interactions) |
| `@dagrejs/dagre` | `^3.0.0` | Lightweight auto-layout for directed graphs (tree/hierarchy) — **recommended for org charts** |
| `elkjs` | `^0.11.1` | Heavy-duty layout engine with massive config options (alternative to dagre) |

### Dagre vs ELK — Which to Use?

| Criteria | Dagre | ELK |
|---|---|---|
| Bundle size | ~40 KB | ~1.4 MB |
| Configuration | Minimal, simple API | Extremely configurable (100s of options) |
| Layout speed | Fast, synchronous | Async (returns a Promise) |
| Horizontal + Vertical | ✅ `rankdir: 'TB'` / `'LR'` | ✅ `elk.direction: 'DOWN'` / `'RIGHT'` |
| Sub-flow support | Partial (open issue #238) | Full |
| Edge routing | No | Yes |

**Recommendation for org chart: Use `@dagrejs/dagre`.** It's simpler, faster, synchronous, small bundle, and perfectly suited for tree/hierarchy layouts. ELK is overkill unless you need advanced edge routing or sub-flow nesting.

---

## 2. Basic Setup (Next.js / React)

### Installation

```bash
npm install @xyflow/react @dagrejs/dagre
```

### Next.js / RSC Gotchas

- **ReactFlow is a client-only component.** It uses browser APIs (DOM measurement, canvas, pointer events).
- You **must** use `'use client'` directive on any component that renders `<ReactFlow />`.
- ReactFlow components will still be server-rendered (pre-rendered HTML) by Next.js — `'use client'` does NOT skip SSR. But hydration will attach the interactive behavior on the client.
- Keep the `<ReactFlow />` wrapper as a leaf client component. Pass data from server components as props.
- Import the CSS stylesheet: `import '@xyflow/react/dist/style.css';`

### Minimal Flow Component

```tsx
'use client';

import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  Panel,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  ConnectionLineType,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// Define nodeTypes OUTSIDE the component to prevent re-renders
const nodeTypes = {
  agentCard: AgentCardNode, // your custom node component
};

function OrgChartFlow({ initialNodes, initialEdges }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      connectionLineType={ConnectionLineType.SmoothStep}
      fitView
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

// Wrap with ReactFlowProvider if you need useReactFlow() in child components
export default function OrgChart(props) {
  return (
    <ReactFlowProvider>
      <OrgChartFlow {...props} />
    </ReactFlowProvider>
  );
}
```

---

## 3. Auto-Layout Pattern with Dagre

This is the core pattern for computing tree positions from a flat list of nodes + edges.

```tsx
import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';

const NODE_WIDTH = 280;  // width of your custom agent card
const NODE_HEIGHT = 120; // height of your custom agent card

/**
 * Compute a tree layout using dagre.
 * @param nodes - ReactFlow nodes array
 * @param edges - ReactFlow edges array  
 * @param direction - 'TB' (top-to-bottom) or 'LR' (left-to-right)
 */
export function getLayoutedElements(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB'
) {
  const dagreGraph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  const isHorizontal = direction === 'LR';

  dagreGraph.setGraph({
    rankdir: direction,
    nodesep: 50,   // horizontal spacing between nodes in same rank
    ranksep: 100,  // vertical spacing between ranks
    marginx: 20,
    marginy: 20,
  });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const pos = dagreGraph.node(node.id);
    return {
      ...node,
      // Dagre centers nodes; ReactFlow positions from top-left
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
      targetPosition: isHorizontal ? 'left' : 'top',
      sourcePosition: isHorizontal ? 'right' : 'bottom',
    };
  });

  return { nodes: layoutedNodes, edges };
}
```

### Usage: Re-layout on data change

```tsx
const onLayout = useCallback((direction: 'TB' | 'LR') => {
  const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(
    nodes,
    edges,
    direction,
  );
  setNodes([...layoutedNodes]);
  setEdges([...layoutedEdges]);
}, [nodes, edges, setNodes, setEdges]);
```

### Dagre Config Options

```ts
dagreGraph.setGraph({
  rankdir: 'TB',    // 'TB' | 'BT' | 'LR' | 'RL'
  align: undefined, // 'UL' | 'UR' | 'DL' | 'DR' — node alignment within rank
  nodesep: 50,      // px between nodes in same rank
  ranksep: 100,     // px between ranks
  edgesep: 10,      // px between edges
  marginx: 0,       // horizontal margin around graph
  marginy: 0,       // vertical margin around graph
  ranker: 'network-simplex', // 'network-simplex' | 'tight-tree' | 'longest-path'
});
```

---

## 4. Custom Node Pattern (Agent Cards)

Custom nodes are full React components. They can contain any interactive elements (buttons, inputs, dropdowns, etc.).

### Defining a Custom Node

```tsx
'use client';

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

// Type for the data your node carries
type AgentCardData = {
  name: string;
  role: string;
  model: string;
  status: 'active' | 'idle' | 'error';
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
};

// The node component receives NodeProps with your data type
function AgentCardNode({ id, data }: NodeProps<Node<AgentCardData>>) {
  return (
    <div className="agent-card rounded-lg border bg-white p-4 shadow-md w-[260px]">
      {/* Target handle (incoming edge connects here) */}
      <Handle type="target" position={Position.Top} className="!bg-gray-400" />

      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">{data.name}</h3>
        <span className={`h-2 w-2 rounded-full ${
          data.status === 'active' ? 'bg-green-500' :
          data.status === 'error' ? 'bg-red-500' : 'bg-gray-300'
        }`} />
      </div>
      <p className="text-xs text-gray-500 mt-1">{data.role}</p>
      <p className="text-xs text-gray-400">{data.model}</p>

      {/* Interactive buttons — use className="nodrag" to prevent drag when clicking */}
      <div className="mt-2 flex gap-2">
        <button
          className="nodrag nopan text-xs text-blue-500 hover:underline"
          onClick={() => data.onEdit?.(id)}
        >
          Edit
        </button>
        <button
          className="nodrag nopan text-xs text-red-500 hover:underline"
          onClick={() => data.onDelete?.(id)}
        >
          Remove
        </button>
      </div>

      {/* Source handle (outgoing edge starts here) */}
      <Handle type="source" position={Position.Bottom} className="!bg-gray-400" />
    </div>
  );
}

// Memoize for performance
export default memo(AgentCardNode);
```

### Key Points for Custom Nodes

- **`className="nodrag"`** — Prevents node dragging when interacting with buttons/inputs inside the node.
- **`className="nopan"`** — Prevents panning the canvas when interacting with elements.
- **Handles** — `<Handle type="target" />` for incoming connections, `<Handle type="source" />` for outgoing.
- **Multiple handles** — You can have multiple source/target handles with unique `id` props.
- **`memo()`** — Always memoize custom nodes for performance (React Flow re-renders nodes on viewport changes).

### Registering Custom Nodes

```tsx
// MUST be defined outside the component to avoid re-renders!
const nodeTypes = {
  agentCard: AgentCardNode,
};

// Then in your flow:
<ReactFlow nodeTypes={nodeTypes} ... />
```

### Creating Node Instances

```tsx
const nodes: Node[] = [
  {
    id: 'orchestrator-1',
    type: 'agentCard',       // matches the key in nodeTypes
    position: { x: 0, y: 0 }, // will be overwritten by dagre layout
    data: {
      name: 'Orchestrator',
      role: 'Root coordinator',
      model: 'gpt-4',
      status: 'active',
    },
  },
  // ... more nodes
];
```

---

## 5. Edge (Connection) Rendering for Parent-Child

### Edge Types

ReactFlow provides several built-in edge types:

| Type | Description | Best for |
|---|---|---|
| `default` | Bézier curve | General purpose |
| `straight` | Straight line | Simple diagrams |
| `step` | Right-angle steps | Flowcharts |
| `smoothstep` | Rounded right-angle steps | **Org charts (recommended)** |

### Creating Edges

```tsx
const edges: Edge[] = [
  {
    id: 'e-orchestrator-worker1',
    source: 'orchestrator-1',   // parent node id
    target: 'worker-1',         // child node id
    type: 'smoothstep',         // nice rounded corners for hierarchy
    animated: false,             // set true for animated dashed line
    style: { stroke: '#94a3b8', strokeWidth: 2 },
    // Optional: label on the edge
    label: 'delegates to',
    labelStyle: { fontSize: 12 },
  },
];
```

### Custom Edge Styles

```tsx
// Default edge options (applies to all edges unless overridden)
<ReactFlow
  defaultEdgeOptions={{
    type: 'smoothstep',
    style: { stroke: '#94a3b8', strokeWidth: 2 },
    animated: false,
  }}
/>
```

---

## 6. Key API Methods (Programmatic Updates)

Access via `useReactFlow()` hook (must be inside `<ReactFlowProvider>`):

```tsx
const {
  // --- Node Operations ---
  getNodes,        // () => Node[]
  getNode,         // (id: string) => Node | undefined
  setNodes,        // (nodes | updaterFn) => void
  addNodes,        // (node | nodes[]) => void
  updateNode,      // (id, partialUpdate) => void
  updateNodeData,  // (id, dataUpdate) => void
  deleteElements,  // ({ nodes?, edges? }) => Promise<{ deletedNodes, deletedEdges }>

  // --- Edge Operations ---
  getEdges,        // () => Edge[]
  getEdge,         // (id: string) => Edge | undefined
  setEdges,        // (edges | updaterFn) => void
  addEdges,        // (edge | edges[]) => void
  updateEdge,      // (id, partialUpdate) => void
  updateEdgeData,  // (id, dataUpdate) => void

  // --- Viewport ---
  fitView,         // (options?) => Promise<boolean>
  zoomIn,          // (options?) => Promise<boolean>
  zoomOut,         // (options?) => Promise<boolean>
  setCenter,       // (x, y, options?) => Promise<boolean>
  getViewport,     // () => Viewport
  setViewport,     // (viewport) => Promise<boolean>

  // --- Utilities ---
  screenToFlowPosition,  // convert screen coords to flow coords (for drag-and-drop)
  toObject,              // () => { nodes, edges, viewport } — for serialization
  getNodesBounds,        // (nodes) => Rect
  getIntersectingNodes,  // (node | rect) => Node[] — collision detection
} = useReactFlow();
```

### Common Programmatic Patterns

```tsx
// Add a new agent node
const addAgent = (parentId: string, agentData: AgentCardData) => {
  const newId = `agent-${Date.now()}`;
  addNodes({
    id: newId,
    type: 'agentCard',
    position: { x: 0, y: 0 }, // will be recalculated by layout
    data: agentData,
  });
  addEdges({
    id: `e-${parentId}-${newId}`,
    source: parentId,
    target: newId,
    type: 'smoothstep',
  });
  // Re-run dagre layout after adding
  requestAnimationFrame(() => relayout());
};

// Remove a node and its edges
const removeAgent = async (nodeId: string) => {
  await deleteElements({ nodes: [{ id: nodeId }] });
  // deleteElements automatically removes connected edges
  requestAnimationFrame(() => relayout());
};

// Update agent data without replacing the node
const updateAgentStatus = (nodeId: string, status: string) => {
  updateNodeData(nodeId, { status });
};

// Serialize the current graph state (for saving to DB)
const saveGraph = () => {
  const { nodes, edges, viewport } = toObject();
  return { nodes, edges, viewport };
};
```

---

## 7. Drag-to-Rearrange Hierarchy

ReactFlow does **not** have built-in "drag to re-parent" for hierarchy changes. You need to implement this yourself. Here's the pattern:

### Approach: `onNodeDragStop` + intersection detection

```tsx
const onNodeDragStop = useCallback((event, draggedNode) => {
  const { getIntersectingNodes, getEdges, setEdges, addEdges } = reactFlowInstance;

  // Find which node the dragged node was dropped onto
  const intersecting = getIntersectingNodes(draggedNode, true);
  const dropTarget = intersecting.find(n => n.id !== draggedNode.id);

  if (dropTarget) {
    // Remove old parent edge
    const currentEdges = getEdges();
    const parentEdge = currentEdges.find(e => e.target === draggedNode.id);

    if (parentEdge) {
      setEdges(edges => edges.filter(e => e.id !== parentEdge.id));
    }

    // Add new parent edge
    addEdges({
      id: `e-${dropTarget.id}-${draggedNode.id}`,
      source: dropTarget.id,
      target: draggedNode.id,
      type: 'smoothstep',
    });

    // Re-run layout
    requestAnimationFrame(() => relayout());
  }
}, [reactFlowInstance]);
```

### Alternative: The Pro "Parent Child Relation" Example

ReactFlow's Pro examples include a "Parent Child Relation" demo that handles:
- Drag a node over a group → attaches as child
- Toolbar "detach" button → removes from parent
- Position calculations for absolute ↔ relative coordinate conversion

This is a **paid Pro example** (requires React Flow Pro subscription).

---

## 8. Horizontal and Vertical Layouts

Both dagre and ELK support switching orientation:

### Dagre

```tsx
// Top-to-bottom (vertical org chart)
dagreGraph.setGraph({ rankdir: 'TB' });

// Left-to-right (horizontal org chart)
dagreGraph.setGraph({ rankdir: 'LR' });

// Remember to also update handle positions:
// TB: targetPosition='top', sourcePosition='bottom'
// LR: targetPosition='left', sourcePosition='right'
```

### ELK

```tsx
const options = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',   // or 'RIGHT', 'UP', 'LEFT'
};
```

### UI Toggle Pattern

```tsx
<Panel position="top-right">
  <button onClick={() => onLayout('TB')}>Vertical</button>
  <button onClick={() => onLayout('LR')}>Horizontal</button>
</Panel>
```

---

## 9. Expand/Collapse Pattern (for large hierarchies)

The Pro example "Expand and Collapse" uses:
- `@dagrejs/dagre` for layout
- A `useExpandCollapse` custom hook that:
  - Tracks expanded/collapsed state in node `data.expanded`
  - Filters visible nodes based on ancestor expansion state
  - Re-runs dagre layout on the visible subset
  - Animates transitions

### Simplified DIY approach:

```tsx
function useExpandCollapse(allNodes, allEdges) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set(['root']));

  const visibleNodes = useMemo(() => {
    // BFS from root, only traverse children of expanded nodes
    const visible = new Set<string>();
    const queue = [allNodes.find(n => /* is root */)];
    while (queue.length) {
      const node = queue.shift()!;
      visible.add(node.id);
      if (expandedIds.has(node.id)) {
        const childEdges = allEdges.filter(e => e.source === node.id);
        childEdges.forEach(e => {
          const child = allNodes.find(n => n.id === e.target);
          if (child) queue.push(child);
        });
      }
    }
    return allNodes
      .filter(n => visible.has(n.id))
      .map(n => ({
        ...n,
        data: { ...n.data, expanded: expandedIds.has(n.id) },
      }));
  }, [allNodes, allEdges, expandedIds]);

  const visibleEdges = useMemo(() => {
    const visibleIds = new Set(visibleNodes.map(n => n.id));
    return allEdges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target));
  }, [allEdges, visibleNodes]);

  const toggle = (nodeId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId);
      return next;
    });
  };

  return { visibleNodes, visibleEdges, toggle };
}
```

---

## 10. Summary: Recommended Stack for Org Chart

```
@xyflow/react    ^12.10.2   — Core flow rendering
@dagrejs/dagre   ^3.0.0     — Auto tree layout
```

**That's it.** No other layout packages needed for a standard org chart.

### Architecture Pattern

1. **Data layer**: Store agent hierarchy as flat arrays of `Node[]` and `Edge[]` (or derive from a tree structure).
2. **Layout layer**: Run `getLayoutedElements()` via dagre whenever nodes/edges change.
3. **Render layer**: `<ReactFlow>` with custom `agentCard` node type.
4. **Interaction layer**: `onNodeDragStop` + `getIntersectingNodes` for drag-to-rearrange; `useReactFlow()` for programmatic CRUD.
5. **Persistence**: `toObject()` to serialize; reconstruct from saved JSON.

### File Organization Suggestion

```
components/
  org-chart/
    OrgChart.tsx              — Main wrapper ('use client'), ReactFlowProvider
    OrgChartFlow.tsx          — Inner flow component with state management
    nodes/
      AgentCardNode.tsx       — Custom node component
    edges/
      (default smoothstep is fine — no custom edge needed)
    hooks/
      useAutoLayout.ts        — dagre layout logic
      useExpandCollapse.ts    — expand/collapse tree logic (optional)
    utils/
      layout.ts               — getLayoutedElements() helper
      hierarchy.ts            — tree ↔ flat node/edge conversion
```
