import { describe, it, expect } from "vitest";
import {
  classifyDocument,
  buildFolders,
  countAllItems,
  FOLDER_ORDER,
} from "../../dashboard/src/lib/document-folders";
import type { CompanyDocument, CompanyArtifact } from "../../dashboard/src/lib/types";

// ─── Fixtures ─────────────────────────────────────────────────

function makeDoc(overrides: Partial<CompanyDocument> & { id: string; title: string }): CompanyDocument {
  return {
    type: "workspace_document",
    body: "test body",
    createdAt: "2025-01-15T10:00:00Z",
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<CompanyArtifact> & { path: string; title: string }): CompanyArtifact {
  return {
    kind: "content_asset",
    excerpt: "",
    updatedAt: "2025-01-15T10:00:00Z",
    ...overrides,
  };
}

// ─── classifyDocument ─────────────────────────────────────────

describe("FinderDocuments: classifyDocument", () => {
  it("classifies daily_report type as Reports", () => {
    const doc = makeDoc({ id: "d1", title: "Update", type: "daily_report" });
    expect(classifyDocument(doc)).toBe("Reports");
  });

  it("classifies executive-brief path as Reports", () => {
    const doc = makeDoc({ id: "d2", title: "Brief", path: "docs/executive-brief-2025.md" });
    expect(classifyDocument(doc)).toBe("Reports");
  });

  it("classifies title with 'executive brief' as Reports", () => {
    const doc = makeDoc({ id: "d3", title: "Daily Executive Brief — Jan 15" });
    expect(classifyDocument(doc)).toBe("Reports");
  });

  it("classifies title with 'daily update' as Reports", () => {
    const doc = makeDoc({ id: "d4", title: "Daily Update for Jan 15" });
    expect(classifyDocument(doc)).toBe("Reports");
  });

  it("classifies mission type as Mission", () => {
    const doc = makeDoc({ id: "d5", title: "Company Goal", type: "mission" });
    expect(classifyDocument(doc)).toBe("Mission");
  });

  it("classifies docs/mission.md path as Mission", () => {
    const doc = makeDoc({ id: "d6", title: "Our Focus", path: "docs/mission.md" });
    expect(classifyDocument(doc)).toBe("Mission");
  });

  it("classifies genesis_prompt path as Mission", () => {
    const doc = makeDoc({ id: "d7", title: "Genesis", path: "genesis_prompt" });
    expect(classifyDocument(doc)).toBe("Mission");
  });

  it("classifies title containing 'mission' as Mission", () => {
    const doc = makeDoc({ id: "d8", title: "Updated Mission Statement" });
    expect(classifyDocument(doc)).toBe("Mission");
  });

  it("classifies docs/plan.md as Plans", () => {
    const doc = makeDoc({ id: "d9", title: "Plan", path: "docs/plan.md" });
    expect(classifyDocument(doc)).toBe("Plans");
  });

  it("classifies title with 'current plan' as Plans", () => {
    const doc = makeDoc({ id: "d10", title: "Current Plan v2" });
    expect(classifyDocument(doc)).toBe("Plans");
  });

  it("classifies title with 'operating plan' as Plans", () => {
    const doc = makeDoc({ id: "d11", title: "Operating Plan Q1" });
    expect(classifyDocument(doc)).toBe("Plans");
  });

  it("classifies workspace_document with workspace category as Deliverables", () => {
    const doc = makeDoc({
      id: "d12",
      title: "Buyer Persona",
      type: "workspace_document",
      category: "workspace",
    });
    expect(classifyDocument(doc)).toBe("Deliverables");
  });

  it("classifies unrecognized documents as Workspace", () => {
    const doc = makeDoc({ id: "d13", title: "Random Notes", type: "escalation" });
    expect(classifyDocument(doc)).toBe("Workspace");
  });

  it("classifies milestone type as Workspace (catch-all)", () => {
    const doc = makeDoc({ id: "d14", title: "Milestone 1", type: "milestone" });
    expect(classifyDocument(doc)).toBe("Workspace");
  });
});

// ─── buildFolders ─────────────────────────────────────────────

describe("FinderDocuments: buildFolders", () => {
  it("returns all 5 folders even when empty", () => {
    const folders = buildFolders([]);
    expect(folders).toHaveLength(5);
    expect(folders.map((f) => f.name)).toEqual(FOLDER_ORDER);
    for (const folder of folders) {
      expect(folder.items).toHaveLength(0);
    }
  });

  it("places documents into correct folders", () => {
    const docs: CompanyDocument[] = [
      makeDoc({ id: "d1", title: "Brief", type: "daily_report" }),
      makeDoc({ id: "d2", title: "Company Mission", type: "mission" }),
      makeDoc({ id: "d3", title: "Current Plan", path: "docs/plan.md" }),
      makeDoc({ id: "d4", title: "Persona", type: "workspace_document", category: "workspace" }),
      makeDoc({ id: "d5", title: "Misc", type: "escalation" }),
    ];
    const folders = buildFolders(docs);

    expect(folders.find((f) => f.name === "Reports")!.items).toHaveLength(1);
    expect(folders.find((f) => f.name === "Mission")!.items).toHaveLength(1);
    expect(folders.find((f) => f.name === "Plans")!.items).toHaveLength(1);
    expect(folders.find((f) => f.name === "Deliverables")!.items).toHaveLength(1);
    expect(folders.find((f) => f.name === "Workspace")!.items).toHaveLength(1);
  });

  it("filters out question-type documents", () => {
    const docs: CompanyDocument[] = [
      makeDoc({ id: "q1", title: "Question?", type: "question" }),
      makeDoc({ id: "d1", title: "Brief", type: "daily_report" }),
    ];
    const folders = buildFolders(docs);
    const totalItems = countAllItems(folders);
    expect(totalItems).toBe(1);
  });

  it("sorts items by date descending within each folder", () => {
    const docs: CompanyDocument[] = [
      makeDoc({ id: "d1", title: "Old Brief", type: "daily_report", createdAt: "2025-01-01T00:00:00Z" }),
      makeDoc({ id: "d2", title: "New Brief", type: "daily_report", createdAt: "2025-01-15T00:00:00Z" }),
      makeDoc({ id: "d3", title: "Mid Brief", type: "daily_report", createdAt: "2025-01-10T00:00:00Z" }),
    ];
    const folders = buildFolders(docs);
    const reports = folders.find((f) => f.name === "Reports")!.items;
    expect(reports[0].title).toBe("New Brief");
    expect(reports[1].title).toBe("Mid Brief");
    expect(reports[2].title).toBe("Old Brief");
  });

  it("does not cap document count (shows ALL documents)", () => {
    const docs: CompanyDocument[] = Array.from({ length: 50 }, (_, i) =>
      makeDoc({
        id: `d${i}`,
        title: `Brief ${i}`,
        type: "daily_report",
        createdAt: `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      }),
    );
    const folders = buildFolders(docs);
    const reports = folders.find((f) => f.name === "Reports")!.items;
    expect(reports).toHaveLength(50);
  });

  it("adds artifacts to Workspace folder", () => {
    const docs: CompanyDocument[] = [];
    const artifacts: CompanyArtifact[] = [
      makeArtifact({ path: "art1", title: "Landing Page" }),
      makeArtifact({ path: "art2", title: "Logo", previewDataUrl: "data:image/png;base64,..." }),
    ];
    const folders = buildFolders(docs, artifacts);
    const workspace = folders.find((f) => f.name === "Workspace")!.items;
    expect(workspace).toHaveLength(2);
    expect(workspace[0].kind).toBe("artifact");
    expect(workspace[1].kind).toBe("artifact");
  });

  it("marks artifacts with previewDataUrl as isImage=true", () => {
    const artifacts: CompanyArtifact[] = [
      makeArtifact({ path: "a1", title: "Logo", previewDataUrl: "data:image/png;base64,abc" }),
      makeArtifact({ path: "a2", title: "Report" }),
    ];
    const folders = buildFolders([], artifacts);
    const workspace = folders.find((f) => f.name === "Workspace")!.items;
    const imageItem = workspace.find((i) => i.title === "Logo")!;
    const docItem = workspace.find((i) => i.title === "Report")!;
    expect(imageItem.isImage).toBe(true);
    expect(docItem.isImage).toBe(false);
  });

  it("preserves document body and agent name in folder items", () => {
    const docs: CompanyDocument[] = [
      makeDoc({ id: "d1", title: "Brief", type: "daily_report", body: "Full content", agentName: "CEO Agent" }),
    ];
    const folders = buildFolders(docs);
    const item = folders.find((f) => f.name === "Reports")!.items[0];
    expect(item.body).toBe("Full content");
    expect(item.agentName).toBe("CEO Agent");
  });
});

// ─── countAllItems ────────────────────────────────────────────

describe("FinderDocuments: countAllItems", () => {
  it("returns 0 for empty folders", () => {
    expect(countAllItems(buildFolders([]))).toBe(0);
  });

  it("returns total count across all folders", () => {
    const docs: CompanyDocument[] = [
      makeDoc({ id: "d1", title: "Brief", type: "daily_report" }),
      makeDoc({ id: "d2", title: "Mission", type: "mission" }),
      makeDoc({ id: "d3", title: "Misc", type: "escalation" }),
    ];
    expect(countAllItems(buildFolders(docs))).toBe(3);
  });
});
