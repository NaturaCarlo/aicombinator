"use client";

import { useState, useMemo } from "react";
import { FileText, Image as ImageIcon, Folder, ChevronRight, X } from "lucide-react";
import { MarkdownContent } from "./markdown-content";
import { buildFolders, countAllItems, FOLDER_ORDER } from "@/lib/document-folders";
import type { FolderName, FolderItem, FolderDefinition } from "@/lib/document-folders";
import type { CompanyDocument, CompanyArtifact } from "@/lib/types";

// ─── Helpers ─────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function fileIcon(item: FolderItem) {
  if (item.isImage) {
    return <ImageIcon className="h-3.5 w-3.5 text-accent-orange shrink-0" />;
  }
  return <FileText className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
}

// ─── Sub-components ──────────────────────────────────────────

function FolderSidebar({
  folders,
  selected,
  onSelect,
}: {
  folders: FolderDefinition[];
  selected: FolderName | null;
  onSelect: (name: FolderName | null) => void;
}) {
  return (
    <div className="w-48 shrink-0 border-r border-border overflow-y-auto">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${
          selected === null
            ? "bg-accent-orange/10 text-accent-orange font-semibold"
            : "text-muted-foreground hover:bg-secondary/30"
        }`}
      >
        <Folder className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate flex-1">All Documents</span>
      </button>
      {folders.map((folder) => (
        <button
          key={folder.name}
          type="button"
          onClick={() => onSelect(folder.name)}
          className={`w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors ${
            selected === folder.name
              ? "bg-accent-orange/10 text-accent-orange font-semibold"
              : "text-muted-foreground hover:bg-secondary/30"
          }`}
        >
          <Folder className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate flex-1">{folder.name}</span>
          <span className="ml-auto text-[10px] bg-secondary/50 rounded-none px-1.5 py-0.5 tabular-nums">
            {folder.items.length}
          </span>
        </button>
      ))}
    </div>
  );
}

function Breadcrumb({
  folderName,
  onNavigateRoot,
}: {
  folderName: FolderName | null;
  onNavigateRoot: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border text-xs text-muted-foreground">
      <button
        type="button"
        onClick={onNavigateRoot}
        className={`hover:text-foreground transition-colors ${
          folderName === null ? "text-foreground font-medium" : ""
        }`}
      >
        Documents
      </button>
      {folderName && (
        <>
          <ChevronRight className="h-3 w-3" />
          <span className="text-foreground font-medium">{folderName}</span>
        </>
      )}
    </div>
  );
}

function FileRow({
  item,
  onSelect,
}: {
  item: FolderItem;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left px-4 py-2.5 hover:bg-secondary/30 transition-colors flex items-center gap-3"
    >
      {item.isImage && item.previewDataUrl ? (
        <img
          src={item.previewDataUrl}
          alt={item.title}
          className="h-8 w-8 rounded object-cover shrink-0"
        />
      ) : (
        fileIcon(item)
      )}
      <span className="text-xs font-medium truncate flex-1 min-w-0">
        {item.title}
      </span>
      <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
        {timeAgo(item.date)}
      </span>
      {item.agentName && (
        <span className="text-[10px] text-muted-foreground/60 shrink-0 max-w-[80px] truncate">
          {item.agentName}
        </span>
      )}
    </button>
  );
}

function FilePreview({
  item,
  onClose,
}: {
  item: FolderItem;
  onClose: () => void;
}) {
  return (
    <div className="border-t border-border bg-secondary/10 max-h-[50%] overflow-y-auto shrink-0">
      <div className="flex items-start justify-between px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground truncate">{item.title}</h2>
          <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
            <span>{new Date(item.date).toLocaleDateString()}</span>
            {item.agentName && (
              <>
                <span>·</span>
                <span>{item.agentName}</span>
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-secondary/50 transition-colors text-muted-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="px-4 pb-4">
        {item.isImage && item.previewDataUrl ? (
          <img
            src={item.previewDataUrl}
            alt={item.title}
            className="max-w-full rounded-none border border-border"
          />
        ) : item.body.trim() ? (
          <div className="rounded-none border border-border bg-secondary/20 px-4 py-3">
            <MarkdownContent
              content={item.body}
              className="text-[12px] leading-relaxed text-foreground"
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic">No content available.</p>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

export function FinderDocuments({
  documents,
  artifacts,
  isLoading,
}: {
  documents: CompanyDocument[] | undefined;
  artifacts?: CompanyArtifact[];
  isLoading: boolean;
}) {
  const [selectedFolder, setSelectedFolder] = useState<FolderName | null>(null);
  const [selectedItem, setSelectedItem] = useState<FolderItem | null>(null);

  const folders = useMemo(
    () => buildFolders(documents || [], artifacts),
    [documents, artifacts],
  );

  const visibleItems = useMemo(() => {
    if (selectedFolder === null) {
      // All documents view: merge and sort all items
      return folders.flatMap((f) => f.items).sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
      );
    }
    return folders.find((f) => f.name === selectedFolder)?.items || [];
  }, [folders, selectedFolder]);

  if (isLoading) {
    return (
      <div className="card-clean p-4">
        <div className="shimmer h-4 w-32 rounded mb-3" />
        <div className="space-y-2">
          <div className="shimmer h-8 w-full rounded" />
          <div className="shimmer h-8 w-full rounded" />
        </div>
      </div>
    );
  }

  const totalCount = countAllItems(folders);
  if (totalCount === 0) return null;

  return (
    <div className="card-clean overflow-hidden">
      {/* Section header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
        <FileText className="h-3.5 w-3.5 text-blue-500" />
        <span className="section-label">
          Documents
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">{totalCount}</span>
      </div>

      {/* Two-panel layout — fixed height, independent scrolling */}
      <div className="flex h-[500px]">
        {/* Left: Folder sidebar */}
        <FolderSidebar
          folders={folders}
          selected={selectedFolder}
          onSelect={(name) => {
            setSelectedFolder(name);
            setSelectedItem(null);
          }}
        />

        {/* Right: Main content */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          {/* Breadcrumb */}
          <Breadcrumb
            folderName={selectedFolder}
            onNavigateRoot={() => {
              setSelectedFolder(null);
              setSelectedItem(null);
            }}
          />

          {/* File list */}
          {visibleItems.length === 0 ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <p className="text-xs text-muted-foreground">No documents in this folder</p>
            </div>
          ) : (
            <div className="flex-1 divide-y divide-border overflow-y-auto">
              {visibleItems.map((item) => (
                <FileRow
                  key={item.id}
                  item={item}
                  onSelect={() => setSelectedItem(
                    selectedItem?.id === item.id ? null : item,
                  )}
                />
              ))}
            </div>
          )}

          {/* Preview panel */}
          {selectedItem && (
            <FilePreview
              item={selectedItem}
              onClose={() => setSelectedItem(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
