/**
 * Skill parser/importer — normalizes skills from multiple ecosystem formats
 * into a unified SkillDescriptor type.
 *
 * Supported formats:
 *   1. Paperclip: skills/<slug>/SKILL.md (YAML frontmatter + markdown body)
 *   2. Claude: .claude/skills/*.md (plain markdown, filename becomes slug)
 *   3. Generic: { name, description, instructions } descriptor objects
 *
 * All formats normalize to:
 *   { slug, name, description, instructions }
 */

import { extractFrontmatter } from "./companies-sh.js";
import type { SkillDescriptor } from "./companies-sh.js";

// Re-export for convenience
export type { SkillDescriptor };

// ---------------------------------------------------------------------------
// Format 1: Paperclip SKILL.md (YAML frontmatter + markdown body)
// ---------------------------------------------------------------------------

/**
 * Parse a Paperclip-format skill file (SKILL.md with YAML frontmatter).
 *
 * Expected format:
 * ```
 * ---
 * name: My Skill
 * description: What the skill does
 * ---
 * # Instructions
 * Detailed skill instructions here...
 * ```
 *
 * @param slug - The skill slug (directory name, e.g. "code-review")
 * @param content - The raw SKILL.md file content
 */
export function parsePaperclipSkill(slug: string, content: string): SkillDescriptor {
  const parsed = extractFrontmatter(content);

  if (!parsed) {
    // No frontmatter — treat entire content as instructions
    return {
      slug: normalizeSlug(slug),
      name: slugToName(slug),
      description: "",
      instructions: content.trim(),
    };
  }

  const fm = parsed.frontmatter;
  const name = getStringField(fm, "name") ?? slugToName(slug);
  const description = getStringField(fm, "description") ?? "";
  const instructions = parsed.body || content.trim();

  return {
    slug: normalizeSlug(slug),
    name,
    description,
    instructions,
  };
}

// ---------------------------------------------------------------------------
// Format 2: Claude .claude/skills/*.md (plain markdown)
// ---------------------------------------------------------------------------

/**
 * Parse a Claude-format skill file (plain markdown, no frontmatter expected).
 *
 * The filename (without extension) becomes the slug.
 * The first heading (# or ##) becomes the name.
 * The entire content is the instructions.
 *
 * @param filename - The skill filename (e.g. "code-review.md")
 * @param content - The raw markdown file content
 */
export function parseClaudeSkill(filename: string, content: string): SkillDescriptor {
  // Strip .md extension to get slug
  const slug = normalizeSlug(filename.replace(/\.md$/i, ""));

  // Try to extract name from first heading
  const headingMatch = content.match(/^#+\s+(.+)/m);
  const name = headingMatch?.[1]?.trim() ?? slugToName(slug);

  // Try to extract a description from the first non-heading paragraph
  const descriptionMatch = content.match(/^#+\s+.+\n+([^#\n][^\n]+)/m);
  const description = descriptionMatch?.[1]?.trim() ?? "";

  return {
    slug,
    name,
    description,
    instructions: content.trim(),
  };
}

// ---------------------------------------------------------------------------
// Format 3: Generic skill descriptor
// ---------------------------------------------------------------------------

/**
 * Input format for generic skill descriptors (e.g. from API payloads).
 */
export interface GenericSkillInput {
  name: string;
  description?: string;
  instructions: string;
  slug?: string;
}

/**
 * Normalize a generic skill descriptor object to SkillDescriptor.
 *
 * @param input - A plain object with at least { name, instructions }
 */
export function parseGenericSkill(input: GenericSkillInput): SkillDescriptor {
  const slug = input.slug
    ? normalizeSlug(input.slug)
    : normalizeSlug(input.name);

  return {
    slug,
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    instructions: input.instructions.trim(),
  };
}

// ---------------------------------------------------------------------------
// Batch parser — detects format and parses accordingly
// ---------------------------------------------------------------------------

export interface SkillFileEntry {
  /** Path relative to the package root (e.g. "skills/code-review/SKILL.md" or ".claude/skills/review.md") */
  path: string;
  /** Raw file content */
  content: string;
}

/**
 * Parse a batch of skill files, auto-detecting format by path.
 *
 * - Paths matching `skills/<slug>/SKILL.md` → Paperclip format
 * - Paths matching `.claude/skills/*.md` → Claude format
 * - Everything else → attempt Paperclip-style parse with filename as slug
 */
export function parseSkillFiles(files: SkillFileEntry[]): SkillDescriptor[] {
  const results: SkillDescriptor[] = [];

  for (const file of files) {
    const normalized = file.path.replace(/\\/g, "/");

    // Paperclip: skills/<slug>/SKILL.md
    const paperclipMatch = normalized.match(/skills\/([^/]+)\/SKILL\.md$/i);
    if (paperclipMatch) {
      results.push(parsePaperclipSkill(paperclipMatch[1]!, file.content));
      continue;
    }

    // Claude: .claude/skills/*.md
    const claudeMatch = normalized.match(/\.claude\/skills\/([^/]+\.md)$/i);
    if (claudeMatch) {
      results.push(parseClaudeSkill(claudeMatch[1]!, file.content));
      continue;
    }

    // Fallback: try Paperclip-style parse with filename-derived slug
    const filename = normalized.split("/").pop() ?? normalized;
    const slug = filename.replace(/\.md$/i, "");
    results.push(parsePaperclipSkill(slug, file.content));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a string into a URL-safe slug. */
function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "unnamed";
}

/** Convert a slug to a human-readable name (e.g. "code-review" → "Code Review"). */
function slugToName(slug: string): string {
  return slug
    .split(/[-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Extract a string field from frontmatter, handling arrays. */
function getStringField(
  fm: Record<string, string | string[]>,
  key: string,
): string | null {
  const val = fm[key];
  if (typeof val === "string") return val;
  if (Array.isArray(val) && val.length > 0) return val[0]!;
  return null;
}
