# Dashboard Architecture Deep Investigation Report

## 1. Dashboard Routing & Navigation

### Directory Structure
```
dashboard/src/app/
├── (admin)/           # Admin route group
│   ├── admin/         # Admin pages
│   └── layout.tsx     # Admin layout
├── (app)/             # Main app route group (auth-gated)
│   ├── apply/         # Application form
│   ├── billing/       # Billing page
│   ├── company/       # Company pages
│   │   └── [id]/      # Dynamic company route
│   │       ├── page.tsx        # Main company dashboard
│   │       ├── layout.tsx      # Passthrough layout (<div className="h-full">)
│   │       └── settings/
│   │           └── page.tsx    # Company settings page
│   ├── dashboard/     # General dashboard (redirect/placeholder: 123 bytes)
│   ├── launch/        # Company launch flow
│   ├── portfolio/     # Portfolio of companies
│   └── layout.tsx     # App layout (minimal: h-screen bg-background)
├── (auth)/            # Auth pages (sign-in, sign-up)
├── (public)/          # Public pages (c/ for public profiles, site/)
├── companies/         # Legacy route?
├── globals.css
├── layout.tsx         # Root layout
└── page.tsx           # Landing page (32KB)
```

### Navigation Pattern
- **No tab system** — the company page is a **single monolithic page** with sidebar
- **Left sidebar** (`CompanySidebar`, 240px/w-60): Contains logo/link to portfolio, agent activity feed, compact metrics, settings link, account menu
- **Right panel** (`CeoChatPanel`, 320px/w-80): CEO chat, hidden on mobile/tablet, slide-over on mobile
- **Main content area**: Scrollable, contains company name + status, HomeTab component
- **Settings page** is a separate route: `/company/[id]/settings`
- Navigation between companies goes through `/portfolio`

### How a New `/company/[id]/team` Route Would Fit
- The `[id]/layout.tsx` is a simple passthrough (`<div className="h-full">`)
- A new `dashboard/src/app/(app)/company/[id]/team/page.tsx` would work naturally
- **Key consideration**: The sidebar is rendered *inside* `page.tsx` (not in the layout), so a new page would need to also render `CompanySidebar` or the layout would need refactoring
- The settings page already solves this: it imports `CompanySidebar` independently
- **Best approach**: Follow the settings pattern — import CompanySidebar into the team page directly

---

## 2. Data Flow & State Management

### Primary Pattern: SWR + Auth Fetcher
```typescript
// Pattern used everywhere:
const { getToken } = useAuth(); // Clerk auth
return useSWR<T>(
  key,
  async (url) => {
    const token = await getToken();
    return createAuthFetcher(token)(url);
  },
  { refreshInterval: 5000, ... }
);
```

### Main Data Hook: `useFounderState`
- **Endpoint**: `GET /api/companies/${companyId}/founder-state`
- **Returns**: `FounderState` — the single mega-object containing everything
- **Polling**: 5s when running, 15s when not
- **Contains**: status, credits, agents[], tasks[], documents[], artifacts[], opsSummary

### Other Hooks
| Hook | Endpoint | Return Type | Polling |
|------|----------|-------------|---------|
| `useFounderState` | `/api/companies/:id/founder-state` | `FounderState` | 5s/15s |
| `useAgents` | `/api/companies/:id/agents` | `{ agents: Agent[] }` | 5s |
| `useTasks` | `/api/companies/:id/tasks` | `{ tasks: Task[] }` | 5s |
| `useDocuments` | `/api/companies/:id/documents` | `{ documents, artifacts }` | 5-30s |
| `useCompanyStatus` | Used in settings | `CompanyStatus` | - |
| `useCostByAgent` | `/api/companies/:id/costs/by-agent` | `{ agents: CostByAgent[] }` | - |
| `useBilling` | `/api/billing/status` | `BillingStatus` | - |
| `useRealtimeStatus` | SSE stream | Events trigger mutate | realtime |

### Mutation Pattern
```typescript
// Direct API call + SWR mutate
const token = await getToken();
await updateCompany(companyId, { state: "paused" }, token);
await mutateFounderState(); // re-fetch from server

// Optimistic update pattern (used in AdminActions):
void mutateFounderState(
  (current) => current ? { ...current, state: nextState, ... } : current,
  { revalidate: false }
);
// Then call API, then revalidate
```

### API Layer (`lib/api.ts`)
- `apiFetch<T>()` — central fetch wrapper with timeout (15s GET, 60s write)
- `createAuthFetcher(token)` — returns SWR-compatible fetcher with auth
- All mutations use direct `apiFetch` calls (POST/PATCH/DELETE)
- Base URL: `process.env.NEXT_PUBLIC_API_URL || "https://api.example.com"`

---

## 3. Agent Data Available

### `FounderVisibleAgent` (what the dashboard receives)
```typescript
interface FounderVisibleAgent {
  id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;                    // avatar URL path like "/api/avatars/abc"
  status: "free" | "working" | "paused";
  email_address?: string | null;
  lastActiveAt: string | null;
  lastTurnAt: string | null;
  skills?: AgentSkillBadge[];             // { slug, name }[]
}
```

### `Agent` (full type on dashboard, from listAgents)
```typescript
interface Agent {
  id: string;
  company_id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: AgentStatus;                    // "idle"|"free"|"running"|"working"|"sleeping"|"offline"|"error"|"paused"|"terminated"|"pending_approval"
  reports_to: string | null;              // ✅ EXISTS on Agent type
  capabilities: string;                   // JSON array
  adapter_config: string;                 // JSON
  runtime_config: string;                 // JSON
  permissions: string;                    // JSON
  last_heartbeat_at: string | null;
  metadata: string;                       // JSON
  created_at: string;
  updated_at: string;
  blueprint_id?: string | null;
  model_tier?: string;
  email_address?: string | null;
  total_credits_consumed?: number;
  last_wake_at?: string | null;
  last_sleep_at?: string | null;
  department?: string | null;
}
```

### `reports_to` on `FounderVisibleAgent`?
**NO** — `reports_to` is **NOT** included in `FounderVisibleAgent`. It exists on:
- `Agent` (dashboard type) ✅
- `AgentRow` (worker/src/types.ts) ✅
- `AgentRow` (supervisor/src/types.ts) ✅
- `AdminCompanyAgent` ✅

To get `reports_to` in the founder dashboard:
1. Use `useAgents(companyId)` which returns full `Agent[]` with `reports_to`
2. OR add `reports_to` to `FounderVisibleAgent` in the worker's `founder-state.ts`

### Agent Edit Endpoint: `PATCH /api/agents/:id`
```typescript
// worker/src/routes/agents.ts — handleUpdateAgent
// Accepted fields:
{
  name?: string;
  role?: string;
  title?: string;
  icon?: string;
  reports_to?: string | null;   // ✅ CAN EDIT reports_to
  capabilities?: string[];
  runtime_config?: Record<string, unknown>;
}
```

### Dashboard API wrapper:
```typescript
// lib/api.ts
updateAgent(agentId, updates: Partial<Pick<Agent, "name"|"role"|"title"|"icon"|"reports_to">>, token)
```

### Other Agent Endpoints
- `GET /api/companies/:id/agents` — list all agents
- `POST /api/companies/:id/agents` — create agent
- `GET /api/agents/:id` — get single agent
- `PATCH /api/agents/:id` — update agent ✅
- `POST /api/agents/:id/pause` — pause agent
- `POST /api/agents/:id/resume` — resume agent
- `POST /api/agents/:id/terminate` — terminate agent
- `POST /api/agents/:id/wake` — wake agent
- `POST /api/agents/:id/keys` — create API key

### Worker `AgentRow` (D1 database schema)
```typescript
interface AgentRow {
  id: string;
  company_id: string;
  name: string;
  role: string;
  title: string | null;
  icon: string | null;
  status: AgentStatus;
  reports_to: string | null;        // ✅ In DB
  capabilities: string;             // JSON array
  adapter_config: string;           // JSON
  runtime_config: string;           // JSON
  permissions: string;              // JSON
  last_heartbeat_at: string | null;
  metadata: string;                 // JSON
  blueprint_id: string | null;
  model_tier: ModelTier;
  email_address: string | null;
  total_credits_consumed: number;
  last_wake_at: string | null;
  last_sleep_at: string | null;
  department: string | null;
  webhook_url: string | null;
  adapter_type: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}
```

### Supervisor `AgentRow`
```typescript
interface AgentRow {
  id: string;
  company_id: string;
  blueprint_id: string | null;
  name: string;
  role: string;
  model_tier: ModelTier;
  status: AgentStatus;
  reports_to?: string | null;
  session_id: string | null;
  current_task_id: string | null;
  total_credits: number;
  total_credits_consumed?: number;
  last_wake_at?: string | null;
  last_sleep_at?: string | null;
  email_address?: string | null;
  metadata?: string | null;
  icon?: string | null;
  created_at: string;
  updated_at?: string;
  title?: string | null;
  department?: string | null;
  webhook_url?: string | null;
  adapter_type?: string | null;
  source?: string;
}
```

---

## 4. Task/Goal Data Available

### `FounderVisibleTask` (what the dashboard receives)
```typescript
interface FounderVisibleTask {
  id: string;
  title: string;
  description: string | null;
  status: "active" | "queued" | "waiting_on_founder" | "waiting_on_dependency" | "done" | "paused";
  ownerAgentId: string | null;
  ownerName: string | null;
  ownerTitle: string | null;
  ownerIcon: string | null;
  updatedAt: string;
  completedAt: string | null;
  detail: string | null;                  // Human-readable blocked reason
  parentTaskId: string | null;            // ✅ EXISTS AND WORKS
  action?: FounderTaskAction | null;      // For approval actions
}
```

### `parentTaskId` — Does It Work?
**YES** — `parentTaskId` is:
1. Present in `FounderVisibleTask` ✅
2. Set from `task.parent_task_id` in the projection logic (`founder-state.ts`) ✅
3. Used in the dashboard's `TasksSummary` component for **hierarchical rendering** ✅

The `buildHierarchy()` function in `tasks-summary.tsx` already:
- Groups tasks by parentTaskId
- Renders parent tasks as collapsible "goal headers" with `ParentGoalHeader`
- Shows child tasks with `border-l-2 border-accent-orange/20 ml-6` indentation

### Task Creation/Editing via API
```typescript
// Create task
createTask(companyId, {
  title: string;
  description?: string;
  owner_agent_id?: string;
  parent_task_id?: string;      // ✅ Can set parent
}, token)

// Update task
updateTask(taskId, {
  title?: string;
  description?: string;
  status?: TaskStatus;
  owner_agent_id?: string;
  blocked_reason?: string;
}, token)
```

### Full `Task` type (from raw API)
```typescript
interface Task {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;           // "pending"|"ready"|"todo"|"in_progress"|"blocked"|"done"|"cancelled"|"failed"
  owner_agent_id: string | null;
  blocked_reason: string | null;
  artifact: string | null;
  parent_task_id: string | null;
  created_by_agent_id: string | null;
  created_at: string;
  updated_at: string;
}
```

### Supervisor `TaskRow` (full schema)
```typescript
interface TaskRow {
  id: string;
  company_id: string;
  milestone_id: string;
  title: string;
  description: string | null;
  acceptance_criteria: string;
  depends_on: string;
  owner_agent_id: string | null;
  status: TaskStatus;
  blocked_reason: string | null;
  artifact: string | null;
  credits_spent: number;
  turns_spent: number;
  parent_task_id: string | null;
  created_by: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}
```

---

## 5. Documents Data Available

### `CompanyDocument`
```typescript
interface CompanyDocument {
  id: string;
  type: "mission" | "daily_report" | "milestone" | "escalation" | "question" | "workspace_document";
  title: string;
  body: string;
  agentName?: string;
  createdAt: string;
  excerpt?: string;
  path?: string;               // e.g. "docs/mission.md", "docs/plan.md"
  category?: string;           // e.g. "workspace"
}
```

### `CompanyArtifact`
```typescript
interface CompanyArtifact {
  path: string;                // file path in workspace
  title: string;
  kind: string;                // file type/kind
  excerpt: string;
  updatedAt: string;
  urls?: string[];             // associated URLs
  previewDataUrl?: string;     // data URL for preview
  openUrl?: string;            // direct link to open
}
```

### Document Loading
Documents come from two sources merged in `loadFounderDocumentsSnapshot()`:
1. **Supervisor founder docs** (mission, executive brief, daily update, plan)
2. **Workspace snapshot** (workspace_document type files from the filesystem)

The worker fetches from the supervisor via: `GET /companies/:id/founder-documents` and `GET /companies/:id/workspace/snapshot`

### Current Rendering Approach
`DocumentsSection` component:
1. Classifies documents into 4 categories: `mission`, `daily_brief`, `current_plan`, `deliverable`
2. Shows max: 1 mission, 7 daily briefs, 1 plan, 10 deliverables
3. Each row is **expandable** (toggle to show full markdown body)
4. Uses `MarkdownContent` component for rich rendering
5. Questions are filtered out (`doc.type !== "question"`)

### Document Count
Based on typical selection: up to ~19 documents shown (1 + 7 + 1 + 10), but actual count depends on company age/activity.

---

## 6. Existing Component Patterns

### UI Component Library
- **shadcn/ui** (via `radix-ui` package) — confirmed by `components.json` and `radix-ui` in deps
- Components: `Button`, `Badge`, `Card`, `Dialog`, `Input`, `Textarea`, `Skeleton`
- Pattern: Each UI component in `src/components/ui/` wraps Radix primitives

### Icon Library
- **lucide-react** ✅ (`^0.574.0`)
- **@phosphor-icons/react** (`^2.1.10`) — also available

### Animation/Transition
- **framer-motion** (`^12.34.2`) ✅
- **motion** (`^12.34.2`) — also installed (the newer package name)
- Tailwind `animate-*` classes (via `tw-animate-css`)
- Custom CSS animations in `globals.css`

### Common UI Patterns

**Cards**: `card-clean` CSS class (custom) — a rounded bordered container
```html
<div className="card-clean overflow-hidden">...</div>
<div className="card-clean p-6">...</div>
```

**Loading/Shimmer**: `shimmer` CSS class
```html
<div className="shimmer h-4 w-32 rounded" />
```

**Modals/Dialogs**: Radix Dialog (via shadcn)
```typescript
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
```

**Slide-over**: Custom implementation (not a reusable component)
```tsx
// Mobile CEO chat slide-over in company page:
<div className="fixed right-0 top-0 bottom-0 w-[min(24rem,85vw)] bg-background border-l z-50">
```
No existing reusable slide-over/panel component.

**Collapsible sections**: Custom `AdminCollapsible` in page.tsx, and each task/document row has expand/collapse

**Section headers**: Common pattern:
```tsx
<div className="flex items-center gap-2 px-4 py-3 border-b border-border">
  <Icon className="h-3.5 w-3.5 text-accent-orange" />
  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Title</span>
  <span className="ml-auto text-[10px] text-muted-foreground">count</span>
</div>
```

**Avatar rendering**:
```tsx
{agent.icon ? (
  <img src={resolveAvatarUrl(agent.icon)} alt={agent.name} className="h-7 w-7 rounded-full object-cover" />
) : (
  <span className="text-[10px] font-semibold text-muted-foreground">{agent.name.charAt(0)}</span>
)}
```

### Theme System
- `next-themes` for dark/light mode
- CSS variables for colors (`--background`, `--foreground`, `--accent-orange`, etc.)
- `accent-orange` is the brand color (#FF6600)

---

## 7. Package Check

### From `dashboard/package.json`:

| Package | Version | Relevant For |
|---------|---------|-------------|
| `react` | `19.2.3` | Core |
| `next` | `16.1.6` | Framework |
| `swr` | `^2.4.0` | Data fetching |
| `@clerk/nextjs` | `^6.38.0` | Auth |
| `radix-ui` | `^1.4.3` | UI primitives (shadcn) |
| `lucide-react` | `^0.574.0` | Icons |
| `@phosphor-icons/react` | `^2.1.10` | Alt icons |
| `framer-motion` | `^12.34.2` | Animations |
| `motion` | `^12.34.2` | Animations (newer pkg) |
| `clsx` | `^2.1.1` | Class names |
| `tailwind-merge` | `^3.5.0` | Tailwind class merge |
| `class-variance-authority` | `^0.7.1` | Variant classes |
| `next-themes` | `^0.4.6` | Dark mode |
| `cobe` | `^0.6.5` | Globe animation (landing page) |
| `tailwindcss` | `^4` | Styling |

### Key Finding: **reactflow is NOT installed**
Would need to be added for the goal ancestry tree feature.

### Key Finding: **No headlessui** — uses Radix UI instead (via shadcn)

### Key Finding: **No tree/hierarchy component** installed — would need reactflow or a custom implementation

---

## Summary of Key Architectural Decisions for Features

### For Org Chart Team Page (`/company/[id]/team`)
- Create new route at `src/app/(app)/company/[id]/team/page.tsx`
- Import `CompanySidebar` directly (follow settings page pattern)
- `reports_to` exists on `Agent` (via `useAgents`) but NOT on `FounderVisibleAgent` (via `useFounderState`)
- PATCH `/api/agents/:id` already supports updating `reports_to`
- **reactflow** would need to be installed for visual org chart
- Agents already have `name`, `title`, `role`, `icon`, `email_address`, `department`, `status`

### For Goal Ancestry Tree
- `parentTaskId` already exists and works in `FounderVisibleTask`
- The `buildHierarchy()` function in `tasks-summary.tsx` already creates parent→children groupings
- A tree visualization would need **reactflow** (not installed)
- Or could use a simpler nested list/indented approach matching existing patterns

### For Finder-Style Documents
- Documents have `path` and `category` fields that could support folder-like navigation
- Artifacts have `path` (file paths) and `kind` fields
- Current rendering is a flat, categorized list
- Would need a file-tree or folder-browser component (not currently installed)
- No existing panel/drawer component — would need to build one or use Dialog
