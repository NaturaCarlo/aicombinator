"use client";

import { memo } from "react";

/**
 * Renders a markdown string as formatted HTML inline within the dashboard.
 * Supports headings, bold, italic, inline code, code blocks, lists, tables, and horizontal rules.
 *
 * Wrapped in React.memo to prevent unnecessary re-renders for non-streaming
 * messages whose content hasn't changed.
 */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
  if (!content.trim()) return null;

  return (
    <div
      className={`markdown-rendered ${className}`}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    />
  );
});

/**
 * Normalize markdown content that may have collapsed newlines.
 * Inserts newlines before inline heading markers (## , ### ) and list items
 * so the line-based parser can recognize them properly.
 */
function normalizeMarkdown(text: string): string {
  let result = text.replace(/\r\n/g, "\n");
  // Insert a newline before markdown heading markers (# , ## , ### ) that
  // appear inline — i.e. preceded by text on the same line rather than at
  // the start of a line. This fixes content where newlines were stripped,
  // causing headings like "## Founder Direction" to render as inline bold.
  result = result.replace(/([^\n])(#{1,3}\s)/g, "$1\n$2");
  return result;
}

function renderMarkdown(markdown: string): string {
  const lines = normalizeMarkdown(markdown).split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let codeFence: string[] = [];
  let inCodeFence = false;
  let tableHeader: string[] | null = null;
  let tableRows: string[][] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${formatInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0 || !listType) return;
    blocks.push(`<${listType}>${listItems.map((item) => `<li>${formatInline(item)}</li>`).join("")}</${listType}>`);
    listItems = [];
    listType = null;
  };

  const flushCodeFence = () => {
    if (!inCodeFence) return;
    blocks.push(`<pre><code>${escapeHtml(codeFence.join("\n"))}</code></pre>`);
    codeFence = [];
    inCodeFence = false;
  };

  const flushTable = () => {
    if (!tableHeader) return;
    const headerHtml = tableHeader.map((cell) => `<th>${formatInline(cell)}</th>`).join("");
    const bodyHtml = tableRows.map((row) => `<tr>${row.map((cell) => `<td>${formatInline(cell)}</td>`).join("")}</tr>`).join("");
    blocks.push(`<div class="md-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
    tableHeader = null;
    tableRows = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      flushParagraph();
      flushList();
      flushTable();
      if (inCodeFence) {
        flushCodeFence();
      } else {
        inCodeFence = true;
      }
      continue;
    }

    if (inCodeFence) {
      codeFence.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }

    if (tableHeader && isMarkdownTableRow(line)) {
      tableRows.push(splitMarkdownTableRow(line));
      continue;
    }

    if (tableHeader) {
      flushTable();
    }

    const nextLine = lines[index + 1];
    if (
      isMarkdownTableRow(line)
      && typeof nextLine === "string"
      && isMarkdownTableSeparator(nextLine)
    ) {
      flushParagraph();
      flushList();
      tableHeader = splitMarkdownTableRow(line);
      tableRows = [];
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushTable();
      const level = heading[1].length;
      blocks.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      flushTable();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      flushParagraph();
      flushTable();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(line.replace(/^\d+\.\s+/, ""));
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushTable();
      blocks.push("<hr />");
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCodeFence();
  flushTable();

  return blocks.join("\n");
}

function formatInline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && trimmed.startsWith("|") && trimmed.endsWith("|");
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line.trim());
}

function splitMarkdownTableRow(line: string): string[] {
  return line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
}
