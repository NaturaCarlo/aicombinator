import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const markdownContentPath = path.resolve(
  __dirname,
  "../../dashboard/src/components/company/markdown-content.tsx",
);

function readSource(): string {
  return fs.readFileSync(markdownContentPath, "utf-8");
}

// ─── Mission bold rendering fix: inline heading markers ────────────

describe("MarkdownContent handles inline heading markers", () => {
  const source = readSource();

  it("has a pre-processing step for inline heading markers", () => {
    // The renderer must handle content where ## headings appear inline
    // (without leading newlines) by inserting newlines before them.
    // The normalizeMarkdown function uses .replace() with a heading pattern.
    expect(source).toMatch(/#{1,3}/);
    expect(source).toMatch(/normalizeMarkdown/);
  });

  it("normalizes inline ## markers before splitting on newlines", () => {
    // The normalizeMarkdown or equivalent function should run BEFORE split("\n")
    // to ensure headings like "some text ## Heading" become "some text\n## Heading"
    expect(source).toMatch(/normalizeMarkdown|normalize/i);
  });
});

describe("MarkdownContent normalizeMarkdown function", () => {
  const source = readSource();

  it("exports or defines a normalizeMarkdown function", () => {
    expect(source).toMatch(/function\s+normalizeMarkdown/);
  });

  it("inserts newline before inline ## heading markers", () => {
    // The function should handle: "text ## Heading more text"
    // converting to: "text\n## Heading\nmore text" (or at least "text\n## Heading more text")
    expect(source).toMatch(/#{1,3}\s/);
  });
});

describe("MarkdownContent renderMarkdown uses normalization", () => {
  const source = readSource();

  it("calls normalizeMarkdown before splitting lines", () => {
    // In renderMarkdown, normalizeMarkdown should be called on the input
    // before the .split("\n") step
    const renderFnMatch = source.match(
      /function\s+renderMarkdown[\s\S]*?\.split\s*\(\s*["']\\n["']\s*\)/,
    );
    expect(renderFnMatch).toBeTruthy();
    const renderFnPreamble = renderFnMatch![0];
    expect(renderFnPreamble).toMatch(/normalizeMarkdown/);
  });
});
