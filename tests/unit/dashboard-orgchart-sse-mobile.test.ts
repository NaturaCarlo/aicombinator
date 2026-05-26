import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Read source files for structural assertions ─────────────────

const orgChartPath = path.resolve(
  __dirname,
  "../../dashboard/src/components/company/org-chart.tsx",
);
const orgChartSource = fs.readFileSync(orgChartPath, "utf-8");

const teamPagePath = path.resolve(
  __dirname,
  "../../dashboard/src/app/(app)/company/[id]/team/page.tsx",
);
const teamPageSource = fs.readFileSync(teamPagePath, "utf-8");

const realtimeStatusPath = path.resolve(
  __dirname,
  "../../dashboard/src/hooks/use-realtime-status.ts",
);
const realtimeStatusSource = fs.readFileSync(realtimeStatusPath, "utf-8");

const dashboardPagePath = path.resolve(
  __dirname,
  "../../dashboard/src/app/(app)/company/[id]/page.tsx",
);
const dashboardPageSource = fs.readFileSync(dashboardPagePath, "utf-8");

const sidebarPath = path.resolve(
  __dirname,
  "../../dashboard/src/components/company/company-sidebar.tsx",
);
const sidebarSource = fs.readFileSync(sidebarPath, "utf-8");

const inviteModalPath = path.resolve(
  __dirname,
  "../../dashboard/src/components/company/invite-external-agent-modal.tsx",
);
const inviteModalSource = fs.readFileSync(inviteModalPath, "utf-8");

const apiPath = path.resolve(
  __dirname,
  "../../dashboard/src/lib/api.ts",
);
const apiSource = fs.readFileSync(apiPath, "utf-8");

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

// ─── Pure logic replicas for testability ──────────────────────────

function buildOrgNodes(agents: TestAgent[]): OrgNode[] {
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

// ─── Test data ────────────────────────────────────────────────────

const testAgents: TestAgent[] = [
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
    id: "cto-1",
    name: "Tech Lead",
    role: "cto",
    title: "CTO",
    icon: "/api/avatars/cto",
    status: "working",
    reports_to: "ceo-1",
    total_credits_consumed: 80,
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
    id: "dev-1",
    name: "Dev Agent",
    role: "developer",
    title: "Lead Developer",
    icon: null,
    status: "working",
    reports_to: "cto-1",
    total_credits_consumed: 50,
  },
  {
    id: "dev-2",
    name: "Junior Dev",
    role: "developer",
    title: null,
    icon: null,
    status: "free",
    reports_to: "cto-1",
    total_credits_consumed: 10,
  },
];

// ═══════════════════════════════════════════════════════════════════
// VAL-ORGCHART-001: All Agents Rendered with Correct Hierarchy
// ═══════════════════════════════════════════════════════════════════

describe("VAL-ORGCHART-001 — All Agents Rendered with Correct Hierarchy", () => {
  it("creates a node for every agent", () => {
    const nodes = buildOrgNodes(testAgents);
    expect(nodes).toHaveLength(testAgents.length);
    for (const agent of testAgents) {
      expect(nodes.find((n) => n.id === agent.id)).toBeDefined();
    }
  });

  it("CEO node is a root node (no reports_to creates no incoming edge)", () => {
    const edges = buildOrgEdges(testAgents);
    const ceoAsTarget = edges.find((e) => e.target === "ceo-1");
    expect(ceoAsTarget).toBeUndefined();
  });

  it("CEO is the source for direct report edges", () => {
    const edges = buildOrgEdges(testAgents);
    const ceoOutgoingTargets = edges
      .filter((e) => e.source === "ceo-1")
      .map((e) => e.target)
      .sort();
    expect(ceoOutgoingTargets).toEqual(["cto-1", "sales-1"]);
  });

  it("hierarchy is maintained: dev-1 reports to cto-1", () => {
    const edges = buildOrgEdges(testAgents);
    const devEdge = edges.find((e) => e.target === "dev-1");
    expect(devEdge).toBeDefined();
    expect(devEdge!.source).toBe("cto-1");
  });

  it("OrgChart component uses dagre layout with TB direction", () => {
    expect(orgChartSource).toContain("rankdir: \"TB\"");
    expect(orgChartSource).toContain("dagre.layout");
  });

  it("OrgChart component uses ReactFlow", () => {
    expect(orgChartSource).toContain("ReactFlow");
    expect(orgChartSource).toMatch(/import\s+\{[^}]*ReactFlow[^}]*\}\s+from\s+["']@xyflow\/react["']/);
  });

  it("OrgChart calls fitView on init to ensure CEO is visible at top", () => {
    expect(orgChartSource).toContain("fitView");
    expect(orgChartSource).toMatch(/instance\.fitView\(\)/);
  });

  it("team page renders OrgChart with agents prop", () => {
    expect(teamPageSource).toContain("<OrgChart");
    expect(teamPageSource).toContain("agents={agents}");
  });

  it("team page fetches founder state for agent data", () => {
    expect(teamPageSource).toContain("useFounderState");
    expect(teamPageSource).toMatch(/founderState\?\.agents/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-ORGCHART-002: Click Node Opens Agent Slide-Over
// ═══════════════════════════════════════════════════════════════════

describe("VAL-ORGCHART-002 — Click Node Opens Agent Slide-Over", () => {
  it("OrgChart accepts onAgentClick callback", () => {
    expect(orgChartSource).toContain("onAgentClick");
    expect(orgChartSource).toMatch(/onAgentClick\?:\s*\(agentId:\s*string\)/);
  });

  it("OrgChart registers onNodeClick handler that calls onAgentClick", () => {
    expect(orgChartSource).toContain("onNodeClick={handleNodeClick}");
    expect(orgChartSource).toContain("onAgentClick?.(node.id)");
  });

  it("team page passes handleAgentClick to OrgChart", () => {
    expect(teamPageSource).toContain("onAgentClick={handleAgentClick}");
  });

  it("team page sets selectedAgentId on agent click", () => {
    expect(teamPageSource).toContain("setSelectedAgentId");
    expect(teamPageSource).toMatch(/handleAgentClick.*useCallback/s);
  });

  it("team page renders AgentSlideOver with selected agent", () => {
    expect(teamPageSource).toContain("<AgentSlideOver");
    expect(teamPageSource).toContain("agent={selectedAgent}");
  });

  it("team page finds selected agent from agents list", () => {
    expect(teamPageSource).toMatch(/agents\.find\(\(a\)\s*=>\s*a\.id\s*===\s*selectedAgentId\)/);
  });

  it("AgentSlideOver closes on close callback", () => {
    expect(teamPageSource).toContain("onClose={handleSlideOverClose}");
    expect(teamPageSource).toMatch(/setSelectedAgentId\(null\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-ORGCHART-003: Working Agents Show Animated Indicators
// ═══════════════════════════════════════════════════════════════════

describe("VAL-ORGCHART-003 — Working Agents Show Animated Indicators", () => {
  it("edges for working agents have animated=true", () => {
    const edges = buildOrgEdges(testAgents);
    const workingEdges = edges.filter((e) => {
      const agent = testAgents.find((a) => a.id === e.target);
      return agent?.status === "working";
    });
    expect(workingEdges.length).toBeGreaterThan(0);
    for (const edge of workingEdges) {
      expect(edge.animated).toBe(true);
    }
  });

  it("edges for non-working agents have animated=false", () => {
    const edges = buildOrgEdges(testAgents);
    const nonWorkingEdges = edges.filter((e) => {
      const agent = testAgents.find((a) => a.id === e.target);
      return agent?.status !== "working";
    });
    expect(nonWorkingEdges.length).toBeGreaterThan(0);
    for (const edge of nonWorkingEdges) {
      expect(edge.animated).toBe(false);
    }
  });

  it("AgentNode renders pulsing dot for working status", () => {
    expect(orgChartSource).toContain("animate-ping");
    expect(orgChartSource).toMatch(/data\.status\s*===\s*["']working["']/);
  });

  it("uses amber status dot color for working agents", () => {
    expect(orgChartSource).toContain("bg-amber-500");
    expect(orgChartSource).toMatch(/working:\s*["']bg-amber-500["']/);
  });

  it("uses green status dot color for free agents", () => {
    expect(orgChartSource).toContain("bg-green-500");
    expect(orgChartSource).toMatch(/free:\s*["']bg-green-500["']/);
  });

  it("uses gray status dot color for paused agents", () => {
    expect(orgChartSource).toContain("bg-gray-400");
    expect(orgChartSource).toMatch(/paused:\s*["']bg-gray-400["']/);
  });

  it("pulsing dot only renders when status is working", () => {
    // The animate-ping element is conditionally rendered
    expect(orgChartSource).toMatch(
      /data\.status\s*===\s*["']working["']\s*&&[\s\S]*?animate-ping/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-ORGCHART-004: Canvas Supports Zoom and Pan
// ═══════════════════════════════════════════════════════════════════

describe("VAL-ORGCHART-004 — Canvas Supports Zoom and Pan", () => {
  it("sets minZoom to 0.3", () => {
    expect(orgChartSource).toContain("minZoom={0.3}");
  });

  it("sets maxZoom to 2", () => {
    expect(orgChartSource).toContain("maxZoom={2}");
  });

  it("nodes are not draggable (pan by dragging canvas)", () => {
    expect(orgChartSource).toContain("nodesDraggable={false}");
  });

  it("nodes are not connectable", () => {
    expect(orgChartSource).toContain("nodesConnectable={false}");
  });

  it("elements are selectable", () => {
    expect(orgChartSource).toContain("elementsSelectable={true}");
  });

  it("ReactFlow has fitView prop", () => {
    // fitView used as a prop on ReactFlow
    expect(orgChartSource).toMatch(/<ReactFlow[\s\S]*?fitView[\s\S]*?>/);
  });

  it("hides attribution watermark", () => {
    expect(orgChartSource).toContain("hideAttribution: true");
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-TEAM-001: Invite External Agent Modal
// ═══════════════════════════════════════════════════════════════════

describe("VAL-TEAM-001 — Invite External Agent Modal", () => {
  it("team page has Invite External Agent button", () => {
    expect(teamPageSource).toContain("Invite External Agent");
    expect(teamPageSource).toContain("setInviteOpen(true)");
  });

  it("team page imports InviteExternalAgentModal", () => {
    expect(teamPageSource).toMatch(
      /import\s+\{[^}]*InviteExternalAgentModal[^}]*\}/,
    );
  });

  it("team page renders InviteExternalAgentModal with open state", () => {
    expect(teamPageSource).toContain("<InviteExternalAgentModal");
    expect(teamPageSource).toContain("open={inviteOpen}");
    expect(teamPageSource).toContain("onOpenChange={setInviteOpen}");
  });

  it("InviteExternalAgentModal renders Dialog with proper title", () => {
    expect(inviteModalSource).toContain("<DialogTitle>Invite External Agent</DialogTitle>");
  });

  it("modal has agent name input", () => {
    expect(inviteModalSource).toContain("Agent Name");
    expect(inviteModalSource).toContain('id="agent-name"');
  });

  it("modal has role input", () => {
    expect(inviteModalSource).toContain("Role");
    expect(inviteModalSource).toContain('id="agent-role"');
  });

  it("modal has webhook URL input", () => {
    expect(inviteModalSource).toContain("Webhook URL");
    expect(inviteModalSource).toContain('id="webhook-url"');
  });

  it("modal has adapter type select", () => {
    expect(inviteModalSource).toContain("Adapter Type");
    expect(inviteModalSource).toContain("http-webhook");
    expect(inviteModalSource).toContain("bash");
    expect(inviteModalSource).toContain("codex");
  });

  it("modal submits to correct API endpoint", () => {
    expect(inviteModalSource).toMatch(/\/api\/companies\/.*\/agents\/external/);
    expect(inviteModalSource).toContain('method: "POST"');
  });

  it("modal calls onSuccess after successful submit", () => {
    expect(inviteModalSource).toContain("onSuccess()");
  });

  it("modal shows error message on failure", () => {
    expect(inviteModalSource).toContain('role="alert"');
    expect(inviteModalSource).toContain("{error}");
  });

  it("modal has cancel and submit buttons", () => {
    expect(inviteModalSource).toContain("Cancel");
    expect(inviteModalSource).toContain("Add Agent");
  });

  it("button uses UserPlus icon", () => {
    expect(teamPageSource).toContain("UserPlus");
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-SSE-001: SSE Connection Established on Dashboard
// ═══════════════════════════════════════════════════════════════════

describe("VAL-SSE-001 — SSE Connection Established on Dashboard", () => {
  it("dashboard page imports useRealtimeStatus hook", () => {
    expect(dashboardPageSource).toContain("useRealtimeStatus");
    expect(dashboardPageSource).toMatch(
      /import\s+\{[^}]*useRealtimeStatus[^}]*\}/,
    );
  });

  it("dashboard page calls useRealtimeStatus with company ID", () => {
    expect(dashboardPageSource).toMatch(/useRealtimeStatus\(id,/);
  });

  it("SSE hook creates EventSource via connectStatusStream", () => {
    expect(realtimeStatusSource).toContain("connectStatusStream");
    expect(realtimeStatusSource).toMatch(
      /import\s+\{[^}]*connectStatusStream[^}]*\}/,
    );
  });

  it("connectStatusStream creates EventSource with token auth", () => {
    expect(apiSource).toContain("function connectStatusStream");
    expect(apiSource).toMatch(/new EventSource\(url\)/);
    expect(apiSource).toMatch(/token=.*encodeURIComponent/);
  });

  it("SSE endpoint URL follows correct pattern", () => {
    expect(apiSource).toMatch(/\/api\/companies\/.*\/status\/stream/);
  });

  it("SSE hook tracks connected state", () => {
    expect(realtimeStatusSource).toContain("setConnected(true)");
    expect(realtimeStatusSource).toContain("setConnected(false)");
    expect(realtimeStatusSource).toContain("connected");
  });

  it("SSE hook uses authentication token", () => {
    expect(realtimeStatusSource).toContain("getToken");
    expect(realtimeStatusSource).toMatch(/const token = await getToken\(\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-SSE-002: SSE Events Trigger UI Refresh
// ═══════════════════════════════════════════════════════════════════

describe("VAL-SSE-002 — SSE Events Trigger UI Refresh", () => {
  it("SSE hook parses message data as JSON and dispatches to handler", () => {
    expect(realtimeStatusSource).toContain("JSON.parse(e.data)");
    expect(realtimeStatusSource).toContain("handleEvent(event)");
  });

  it("dashboard page refreshes founderState on SSE event", () => {
    // The onEvent callback should trigger mutateFounderState
    expect(dashboardPageSource).toMatch(
      /useRealtimeStatus\(id,\s*\(\)\s*=>\s*\{[\s\S]*?mutateFounderState/,
    );
  });

  it("SSE hook uses useEffectEvent for stable callback ref", () => {
    expect(realtimeStatusSource).toContain("useEffectEvent");
    expect(realtimeStatusSource).toMatch(/const handleEvent = useEffectEvent\(onEvent\)/);
  });

  it("SSE hook ignores parse errors (e.g. heartbeat pings)", () => {
    expect(realtimeStatusSource).toMatch(/catch\s*\{[\s\S]*?\/\/\s*Ignore parse errors/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-SSE-003: SSE Reconnects After Connection Drop
// ═══════════════════════════════════════════════════════════════════

describe("VAL-SSE-003 — SSE Reconnects After Connection Drop", () => {
  it("SSE hook handles onerror event", () => {
    expect(realtimeStatusSource).toContain("source.onerror");
  });

  it("EventSource built-in auto-reconnect is relied upon", () => {
    // The onerror handler sets connected=false but doesn't close the source
    // EventSource natively auto-reconnects
    expect(realtimeStatusSource).toMatch(
      /source\.onerror\s*=\s*\(\)\s*=>\s*\{[\s\S]*?setConnected\(false\)/,
    );
    // Should NOT call source.close() in the onerror handler
    const onerrorBlock = realtimeStatusSource.match(
      /source\.onerror\s*=\s*\(\)\s*=>\s*\{[^}]*\}/,
    );
    expect(onerrorBlock).toBeDefined();
    expect(onerrorBlock![0]).not.toContain("source.close");
  });

  it("has fallback reconnection on initial connect failure", () => {
    // The catch block in connect() retries after 1 second
    expect(realtimeStatusSource).toMatch(/setTimeout\(connect,\s*1000\)/);
  });

  it("respects cancelled flag to prevent reconnection after cleanup", () => {
    expect(realtimeStatusSource).toContain("if (cancelled) return;");
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-SSE-004: SSE Connection Cleaned Up on Navigation
// ═══════════════════════════════════════════════════════════════════

describe("VAL-SSE-004 — SSE Connection Cleaned Up on Navigation", () => {
  it("SSE hook has cleanup function that closes EventSource", () => {
    expect(realtimeStatusSource).toContain("sourceRef.current.close()");
    expect(realtimeStatusSource).toContain("sourceRef.current = null");
  });

  it("useEffect returns cleanup on unmount", () => {
    // The effect returns a function that sets cancelled=true and calls cleanup
    expect(realtimeStatusSource).toMatch(
      /return\s*\(\)\s*=>\s*\{[\s\S]*?cancelled\s*=\s*true[\s\S]*?cleanup\(\)/,
    );
  });

  it("cleanup sets connected state to false", () => {
    expect(realtimeStatusSource).toMatch(
      /const cleanup = useCallback\(\(\)\s*=>\s*\{[\s\S]*?setConnected\(false\)/,
    );
  });

  it("does nothing when companyId is null", () => {
    expect(realtimeStatusSource).toMatch(/if\s*\(!companyId\)\s*\{[\s\S]*?return/);
  });

  it("useEffect depends on companyId for re-connection on route change", () => {
    expect(realtimeStatusSource).toMatch(/\},\s*\[companyId/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-MOBILE-001: Dashboard Full-Width on Mobile
// ═══════════════════════════════════════════════════════════════════

describe("VAL-MOBILE-001 — Dashboard Full-Width on Mobile", () => {
  it("sidebar is hidden below 1024px (hidden lg:flex)", () => {
    expect(sidebarSource).toMatch(/hidden\s+lg:flex/);
  });

  it("dashboard main content area uses flex-1 to fill width", () => {
    expect(dashboardPageSource).toMatch(/className="flex-1/);
  });

  it("dashboard uses a flex layout for sidebar + content", () => {
    expect(dashboardPageSource).toMatch(
      /className="flex\s+h-full/,
    );
  });

  it("sidebar width is 240px (w-60) on desktop", () => {
    expect(sidebarSource).toContain("w-60");
  });

  it("company layout does not force a fixed width that breaks mobile", () => {
    // Layout should be a simple container without constrained widths
    const layoutPath = path.resolve(
      __dirname,
      "../../dashboard/src/app/(app)/company/[id]/layout.tsx",
    );
    const layoutSource = fs.readFileSync(layoutPath, "utf-8");
    expect(layoutSource).toContain("h-full");
    expect(layoutSource).not.toContain("max-w-");
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-MOBILE-002: CEO Chat Button on Sub-Desktop
// ═══════════════════════════════════════════════════════════════════

describe("VAL-MOBILE-002 — CEO Chat Button on Sub-Desktop", () => {
  it("chat toggle button uses xl:hidden to appear below 1280px", () => {
    expect(dashboardPageSource).toMatch(/xl:hidden.*MessageSquare/s);
  });

  it("chat toggle button uses MessageSquare icon", () => {
    expect(dashboardPageSource).toContain("MessageSquare");
    expect(dashboardPageSource).toMatch(
      /import\s+\{[^}]*MessageSquare[^}]*\}/,
    );
  });

  it("clicking chat button toggles chatOpen state", () => {
    expect(dashboardPageSource).toContain("setChatOpen(!chatOpen)");
  });

  it("desktop chat panel is hidden below xl breakpoint", () => {
    expect(dashboardPageSource).toMatch(/hidden\s+xl:flex/);
  });

  it("mobile chat panel renders when chatOpen is true", () => {
    expect(dashboardPageSource).toMatch(/\{chatOpen\s*&&/);
  });

  it("mobile slide-over renders CeoChatPanel component", () => {
    // Mobile slide-over should contain the actual chat
    expect(dashboardPageSource).toMatch(
      /xl:hidden.*CeoChatPanel/s,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
// VAL-MOBILE-003: Mobile Chat Slide-Over Closes on Backdrop
// ═══════════════════════════════════════════════════════════════════

describe("VAL-MOBILE-003 — Mobile Chat Slide-Over Closes on Backdrop", () => {
  it("mobile chat has a backdrop overlay", () => {
    expect(dashboardPageSource).toContain("bg-black/30");
    expect(dashboardPageSource).toContain("fixed inset-0");
  });

  it("backdrop has onClick handler to close slide-over", () => {
    expect(dashboardPageSource).toMatch(
      /bg-black\/30[\s\S]*?onClick=\{.*?setChatOpen\(false\)/,
    );
  });

  it("backdrop and slide-over use proper z-index layering", () => {
    expect(dashboardPageSource).toContain("z-40");
    expect(dashboardPageSource).toContain("z-50");
  });

  it("slide-over has a max width for mobile", () => {
    expect(dashboardPageSource).toContain("w-[min(24rem,85vw)]");
  });

  it("slide-over is positioned on the right side", () => {
    expect(dashboardPageSource).toContain("fixed right-0 top-0 bottom-0");
  });

  it("slide-over has border and background for visual separation", () => {
    expect(dashboardPageSource).toContain("bg-background border-l border-border");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Additional: OrgChart empty state and edge cases
// ═══════════════════════════════════════════════════════════════════

describe("OrgChart edge cases", () => {
  it("shows empty state when no agents", () => {
    expect(orgChartSource).toContain("No agents in this team yet.");
    expect(orgChartSource).toMatch(/agents\.length\s*===\s*0/);
  });

  it("AgentNode shows avatar image when icon is set", () => {
    expect(orgChartSource).toContain("resolveAvatarUrl");
    expect(orgChartSource).toMatch(/data\.icon\s*\?/);
  });

  it("AgentNode shows initial letter fallback when no icon", () => {
    expect(orgChartSource).toContain("data.name.charAt(0).toUpperCase()");
  });

  it("AgentNode displays name and title/role", () => {
    expect(orgChartSource).toContain("{data.name}");
    expect(orgChartSource).toContain("{data.title || data.role}");
  });

  it("team page shows loading spinner while fetching", () => {
    expect(teamPageSource).toContain("founderStateLoading");
    expect(teamPageSource).toContain("Loading team...");
    expect(teamPageSource).toContain("animate-spin");
  });

  it("team page has import from companies.sh button", () => {
    expect(teamPageSource).toContain("Import from companies.sh");
    expect(teamPageSource).toContain("ImportCompaniesShModal");
  });
});

// ═══════════════════════════════════════════════════════════════════
// Additional: SSE hook architecture
// ═══════════════════════════════════════════════════════════════════

describe("SSE hook architecture", () => {
  it("uses useRef to hold EventSource reference", () => {
    expect(realtimeStatusSource).toContain("useRef<EventSource | null>");
  });

  it("exports the connected state for UI consumption", () => {
    expect(realtimeStatusSource).toContain("return { connected }");
  });

  it("uses async connect function for token retrieval", () => {
    expect(realtimeStatusSource).toMatch(/const connect = async \(\)/);
  });

  it("guards against stale connections with cancelled flag", () => {
    expect(realtimeStatusSource).toContain("let cancelled = false");
    // Multiple guard checks
    const cancelledChecks = realtimeStatusSource.match(/if\s*\(cancelled\)\s*return/g);
    expect(cancelledChecks).toBeDefined();
    expect(cancelledChecks!.length).toBeGreaterThanOrEqual(3);
  });
});
