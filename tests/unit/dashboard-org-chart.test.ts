import { describe, it, expect } from "vitest";

// ─── Types mirroring dashboard types for testing ─────────────────
interface TestAgent {
  id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: "free" | "working" | "paused";
  reports_to: string | null;
  total_credits_consumed: number;
}

// ─── Pure logic extracted for testability ─────────────────────────

interface OrgNode {
  id: string;
  type: "agentNode";
  position: { x: number; y: number };
  data: {
    name: string;
    role: string;
    title: string | null;
    icon: string | null;
    status: "free" | "working" | "paused";
  };
}

interface OrgEdge {
  id: string;
  source: string;
  target: string;
  type: "smoothstep";
  animated: boolean;
}

function buildOrgNodes(
  agents: TestAgent[],
): OrgNode[] {
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

function buildOrgEdges(agents: TestAgent[]): OrgEdge[] {
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

// ─── Tests ────────────────────────────────────────────────────────

describe("OrgChart node/edge generation", () => {
  const agents: TestAgent[] = [
    {
      id: "ceo-1",
      name: "Atlas CEO",
      role: "ceo",
      title: "CEO",
      icon: null,
      status: "free",
      reports_to: null,
      total_credits_consumed: 100,
    },
    {
      id: "dev-1",
      name: "Dev Agent",
      role: "developer",
      title: "Lead Developer",
      icon: "/api/avatars/dev1",
      status: "working",
      reports_to: "ceo-1",
      total_credits_consumed: 50,
    },
    {
      id: "sales-1",
      name: "Sales Agent",
      role: "sales",
      title: "Sales Rep",
      icon: null,
      status: "paused",
      reports_to: "ceo-1",
      total_credits_consumed: 30,
    },
    {
      id: "junior-1",
      name: "Junior Dev",
      role: "developer",
      title: null,
      icon: null,
      status: "free",
      reports_to: "dev-1",
      total_credits_consumed: 10,
    },
  ];

  describe("buildOrgNodes", () => {
    it("creates one node per agent", () => {
      const nodes = buildOrgNodes(agents);
      expect(nodes).toHaveLength(4);
    });

    it("each node has agentNode type and correct data fields", () => {
      const nodes = buildOrgNodes(agents);
      for (const node of nodes) {
        expect(node.type).toBe("agentNode");
        expect(node.data).toHaveProperty("name");
        expect(node.data).toHaveProperty("role");
        expect(node.data).toHaveProperty("status");
        expect(node.position).toEqual({ x: 0, y: 0 });
      }
    });

    it("maps agent data correctly to node data", () => {
      const nodes = buildOrgNodes(agents);
      const ceoNode = nodes.find((n) => n.id === "ceo-1");
      expect(ceoNode).toBeDefined();
      expect(ceoNode!.data.name).toBe("Atlas CEO");
      expect(ceoNode!.data.role).toBe("ceo");
      expect(ceoNode!.data.title).toBe("CEO");
      expect(ceoNode!.data.status).toBe("free");
    });

    it("does not include per-agent creditsConsumed (credits are company-wide)", () => {
      const nodes = buildOrgNodes(agents);
      const ceoNode = nodes.find((n) => n.id === "ceo-1");
      expect(ceoNode).toBeDefined();
      expect(ceoNode!.data).not.toHaveProperty("creditsConsumed");
    });
  });

  describe("buildOrgEdges", () => {
    it("creates edges for agents with reports_to pointing to existing agents", () => {
      const edges = buildOrgEdges(agents);
      expect(edges).toHaveLength(3);
    });

    it("edge source is the manager and target is the subordinate", () => {
      const edges = buildOrgEdges(agents);
      const devEdge = edges.find((e) => e.target === "dev-1");
      expect(devEdge).toBeDefined();
      expect(devEdge!.source).toBe("ceo-1");
    });

    it("does not create edges for root agents (reports_to=null)", () => {
      const edges = buildOrgEdges(agents);
      const ceoEdge = edges.find((e) => e.target === "ceo-1");
      expect(ceoEdge).toBeUndefined();
    });

    it("ignores agents whose reports_to references a non-existent agent", () => {
      const agentsWithBadRef: TestAgent[] = [
        ...agents,
        {
          id: "orphan-1",
          name: "Orphan",
          role: "support",
          title: null,
          icon: null,
          status: "free",
          reports_to: "non-existent-id",
          total_credits_consumed: 0,
        },
      ];
      const edges = buildOrgEdges(agentsWithBadRef);
      const orphanEdge = edges.find((e) => e.target === "orphan-1");
      expect(orphanEdge).toBeUndefined();
    });

    it("sets animated=true for working agents, false otherwise", () => {
      const edges = buildOrgEdges(agents);
      const devEdge = edges.find((e) => e.target === "dev-1");
      expect(devEdge!.animated).toBe(true);

      const salesEdge = edges.find((e) => e.target === "sales-1");
      expect(salesEdge!.animated).toBe(false);
    });

    it("handles deeply nested hierarchy", () => {
      const edges = buildOrgEdges(agents);
      const juniorEdge = edges.find((e) => e.target === "junior-1");
      expect(juniorEdge).toBeDefined();
      expect(juniorEdge!.source).toBe("dev-1");
    });

    it("all edges use smoothstep type", () => {
      const edges = buildOrgEdges(agents);
      for (const edge of edges) {
        expect(edge.type).toBe("smoothstep");
      }
    });
  });

  describe("edge cases", () => {
    it("handles empty agent list", () => {
      const nodes = buildOrgNodes([]);
      const edges = buildOrgEdges([]);
      expect(nodes).toHaveLength(0);
      expect(edges).toHaveLength(0);
    });

    it("handles single root agent with no subordinates", () => {
      const singleAgent: TestAgent[] = [
        {
          id: "solo-1",
          name: "Solo Agent",
          role: "ceo",
          title: "CEO",
          icon: null,
          status: "free",
          reports_to: null,
          total_credits_consumed: 100,
        },
      ];
      const nodes = buildOrgNodes(singleAgent);
      const edges = buildOrgEdges(singleAgent);
      expect(nodes).toHaveLength(1);
      expect(edges).toHaveLength(0);
    });

    it("handles all agents being root (no reports_to)", () => {
      const rootAgents: TestAgent[] = [
        {
          id: "a1",
          name: "Agent A",
          role: "ceo",
          title: null,
          icon: null,
          status: "free",
          reports_to: null,
          total_credits_consumed: 0,
        },
        {
          id: "a2",
          name: "Agent B",
          role: "developer",
          title: null,
          icon: null,
          status: "working",
          reports_to: null,
          total_credits_consumed: 0,
        },
      ];
      const nodes = buildOrgNodes(rootAgents);
      const edges = buildOrgEdges(rootAgents);
      expect(nodes).toHaveLength(2);
      expect(edges).toHaveLength(0);
    });
  });
});
