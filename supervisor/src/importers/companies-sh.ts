/**
 * companies.sh package parser.
 *
 * Fetches and parses a companies.sh package from GitHub.
 * Package structure:
 *   COMPANY.md          – YAML frontmatter (name, description, goals)
 *   agents/<slug>/AGENTS.md – YAML frontmatter (name, role, title, reportsTo)
 *   skills/<slug>/SKILL.md  – Markdown content (skill instructions)
 *
 * The parser outputs structured data:
 *   { company, agents, skills, errors }
 *
 * Handles: malformed YAML, missing files (404), invalid references.
 * Import is idempotent: second import detects existing agents by name.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompanyInfo {
  name: string;
  description: string;
  goals: string[];
}

export interface SkillDescriptor {
  slug: string;
  name: string;
  description: string;
  instructions: string;
}

export interface AgentDefinition {
  name: string;
  role: string;
  title: string;
  reportsTo: string | null;
  skills: string[];
  /** Directory slug from the companies.sh package (e.g. "ceo", "qa-engineer"). */
  slug: string;
}

export interface ImportResult {
  company: CompanyInfo;
  agents: AgentDefinition[];
  skills: SkillDescriptor[];
  errors: string[];
}

export interface ImportError {
  type: "invalid_reference" | "fetch_error" | "parse_error" | "missing_file";
  message: string;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Extracts YAML frontmatter (delimited by ---) from markdown content.
 * Returns the parsed key-value pairs and the remaining body content.
 */
export function extractFrontmatter(
  content: string,
): { frontmatter: Record<string, string | string[]>; body: string } | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) {
    return null;
  }

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    return null;
  }

  const frontmatterBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();
  const frontmatter: Record<string, string | string[]> = {};

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of frontmatterBlock.split("\n")) {
    const trimmedLine = line.trim();

    // Skip empty lines and comments
    if (trimmedLine === "" || trimmedLine.startsWith("#")) {
      continue;
    }

    // Check for a list item (starts with "- ")
    if (trimmedLine.startsWith("- ") && currentKey !== null) {
      const value = trimmedLine.slice(2).trim();
      if (currentList === null) {
        currentList = [];
      }
      currentList.push(stripQuotes(value));
      frontmatter[currentKey] = currentList;
      continue;
    }

    // Check for key: value pair
    const colonIndex = trimmedLine.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }

    // Flush previous list
    currentList = null;

    const key = trimmedLine.slice(0, colonIndex).trim();
    const rawValue = trimmedLine.slice(colonIndex + 1).trim();

    currentKey = key;

    if (rawValue === "" || rawValue === "|" || rawValue === ">") {
      // The value might be a list or multiline block following
      continue;
    }

    frontmatter[key] = stripQuotes(rawValue);
  }

  return { frontmatter, body };
}

/** Strip surrounding quotes from a YAML string value. */
function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Package reference parser
// ---------------------------------------------------------------------------

/**
 * Parse a package reference into owner/repo/path components.
 *
 * Accepted formats:
 *   - "owner/repo/package"        → fetch from GitHub raw (main branch)
 *   - "https://github.com/owner/repo" or full URL variants
 *   - "owner/repo"                → root-level package
 */
export function parsePackageRef(ref: string): {
  owner: string;
  repo: string;
  path: string;
} | null {
  const trimmed = ref.trim();

  // Handle full GitHub URLs
  const githubUrlMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/[^/]+\/(.+))?(?:\/)?$/,
  );
  if (githubUrlMatch) {
    const [, owner, repo, subpath] = githubUrlMatch;
    return {
      owner: owner!,
      repo: repo!,
      path: subpath ?? "",
    };
  }

  // Handle raw GitHub content URLs
  const rawGithubMatch = trimmed.match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/[^/]+\/(.+)$/,
  );
  if (rawGithubMatch) {
    const [, owner, repo, subpath] = rawGithubMatch;
    return {
      owner: owner!,
      repo: repo!,
      path: subpath ?? "",
    };
  }

  // Handle slash-separated references: "owner/repo/path" or "owner/repo"
  const parts = trimmed.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  return {
    owner: parts[0]!,
    repo: parts[1]!,
    path: parts.slice(2).join("/"),
  };
}

// ---------------------------------------------------------------------------
// GitHub raw content fetcher (injectable for testing)
// ---------------------------------------------------------------------------

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const defaultFetch: FetchFn = async (url: string) => {
  const resp = await fetch(url);
  return {
    ok: resp.ok,
    status: resp.status,
    text: () => resp.text(),
  };
};

function buildRawUrl(owner: string, repo: string, basePath: string, filePath: string): string {
  const parts = [owner, repo, "main"];
  if (basePath) {
    parts.push(basePath);
  }
  parts.push(filePath);
  return `https://raw.githubusercontent.com/${parts.join("/")}`;
}

// ---------------------------------------------------------------------------
// Directory listing via GitHub API (for discovering agents and skills dirs)
// ---------------------------------------------------------------------------

interface GitHubTreeItem {
  path: string;
  type: string;
}

interface GitHubTreeResponse {
  tree: GitHubTreeItem[];
  truncated?: boolean;
}

/**
 * List subdirectories under a given path in a GitHub repo using the Trees API.
 * Returns an array of directory names (slugs).
 */
async function listSubdirectories(
  owner: string,
  repo: string,
  basePath: string,
  dirName: string,
  fetchFn: FetchFn,
): Promise<string[]> {
  // Use GitHub API to get the repo tree (recursive)
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`;
  const resp = await fetchFn(apiUrl);
  if (!resp.ok) {
    return [];
  }

  const text = await resp.text();
  let tree: GitHubTreeResponse;
  try {
    tree = JSON.parse(text) as GitHubTreeResponse;
  } catch {
    return [];
  }

  const prefix = basePath ? `${basePath}/${dirName}/` : `${dirName}/`;
  const slugs = new Set<string>();

  for (const item of tree.tree) {
    if (item.path.startsWith(prefix) && item.type === "blob") {
      // Extract the slug (first directory component after prefix)
      const remainder = item.path.slice(prefix.length);
      const slashIndex = remainder.indexOf("/");
      if (slashIndex !== -1) {
        slugs.add(remainder.slice(0, slashIndex));
      }
    }
  }

  return Array.from(slugs);
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parse a companies.sh package from GitHub.
 *
 * @param packageRef  Package reference (e.g. "paperclipai/companies/gstack")
 * @param fetchFn     Injectable fetch function (for testing)
 */
export async function parseCompaniesShPackage(
  packageRef: string,
  fetchFn: FetchFn = defaultFetch,
): Promise<ImportResult> {
  const errors: string[] = [];
  const agents: AgentDefinition[] = [];
  const skills: SkillDescriptor[] = [];

  // 1. Parse package reference
  const parsed = parsePackageRef(packageRef);
  if (!parsed) {
    return {
      company: { name: "", description: "", goals: [] },
      agents: [],
      skills: [],
      errors: [`Invalid package reference: "${packageRef}". Expected format: "owner/repo/path" or a GitHub URL.`],
    };
  }

  const { owner, repo, path: basePath } = parsed;

  // 2. Fetch COMPANY.md
  const companyUrl = buildRawUrl(owner, repo, basePath, "COMPANY.md");
  let company: CompanyInfo = { name: "", description: "", goals: [] };

  try {
    const companyResp = await fetchFn(companyUrl);
    if (!companyResp.ok) {
      if (companyResp.status === 404) {
        errors.push(`COMPANY.md not found at ${companyUrl}`);
      } else {
        errors.push(`Failed to fetch COMPANY.md: HTTP ${companyResp.status}`);
      }
    } else {
      const content = await companyResp.text();
      const parsed = extractFrontmatter(content);
      if (!parsed) {
        errors.push("COMPANY.md: Could not extract YAML frontmatter. Expected content delimited by ---.");
      } else {
        const fm = parsed.frontmatter;
        company = {
          name: getString(fm, "name") ?? "",
          description: getString(fm, "description") ?? "",
          goals: getStringArray(fm, "goals"),
        };

        if (!company.name) {
          errors.push("COMPANY.md: Missing required field 'name' in frontmatter.");
        }
      }
    }
  } catch (err) {
    errors.push(`Failed to fetch COMPANY.md: ${errorMessage(err)}`);
  }

  // 3. Discover and fetch agent definitions
  let agentSlugs: string[] = [];
  try {
    agentSlugs = await listSubdirectories(owner, repo, basePath, "agents", fetchFn);
  } catch (err) {
    errors.push(`Failed to list agent directories: ${errorMessage(err)}`);
  }

  for (const slug of agentSlugs) {
    const agentUrl = buildRawUrl(owner, repo, basePath, `agents/${slug}/AGENTS.md`);
    try {
      const resp = await fetchFn(agentUrl);
      if (!resp.ok) {
        if (resp.status === 404) {
          errors.push(`agents/${slug}/AGENTS.md not found (404).`);
        } else {
          errors.push(`Failed to fetch agents/${slug}/AGENTS.md: HTTP ${resp.status}`);
        }
        continue;
      }

      const content = await resp.text();
      const parsed = extractFrontmatter(content);
      if (!parsed) {
        errors.push(`agents/${slug}/AGENTS.md: Could not extract YAML frontmatter.`);
        continue;
      }

      const fm = parsed.frontmatter;
      const agentName = getString(fm, "name");
      if (!agentName) {
        errors.push(`agents/${slug}/AGENTS.md: Missing required field 'name'.`);
        continue;
      }

      agents.push({
        name: agentName,
        role: getString(fm, "role") ?? "specialist",
        title: getString(fm, "title") ?? agentName,
        reportsTo: getString(fm, "reportsTo") ?? null,
        skills: getStringArray(fm, "skills"),
        slug,
      });
    } catch (err) {
      errors.push(`Failed to fetch agents/${slug}/AGENTS.md: ${errorMessage(err)}`);
    }
  }

  // 4. Discover and fetch skill definitions
  let skillSlugs: string[] = [];
  try {
    skillSlugs = await listSubdirectories(owner, repo, basePath, "skills", fetchFn);
  } catch (err) {
    errors.push(`Failed to list skill directories: ${errorMessage(err)}`);
  }

  for (const slug of skillSlugs) {
    const skillUrl = buildRawUrl(owner, repo, basePath, `skills/${slug}/SKILL.md`);
    try {
      const resp = await fetchFn(skillUrl);
      if (!resp.ok) {
        if (resp.status === 404) {
          errors.push(`skills/${slug}/SKILL.md not found (404).`);
        } else {
          errors.push(`Failed to fetch skills/${slug}/SKILL.md: HTTP ${resp.status}`);
        }
        continue;
      }

      const content = await resp.text();
      const parsed = extractFrontmatter(content);

      let name = slug;
      let description = "";
      let instructions = content;

      if (parsed) {
        name = getString(parsed.frontmatter, "name") ?? slug;
        description = getString(parsed.frontmatter, "description") ?? "";
        instructions = parsed.body || content;
      }

      skills.push({
        slug,
        name,
        description,
        instructions,
      });
    } catch (err) {
      errors.push(`Failed to fetch skills/${slug}/SKILL.md: ${errorMessage(err)}`);
    }
  }

  // 5. Map agent skills to resolved skill descriptors
  for (const agent of agents) {
    // If agent has skill references, verify they exist
    for (const skillRef of agent.skills) {
      const found = skills.find(
        (s) => s.slug === skillRef || s.name === skillRef,
      );
      if (!found) {
        errors.push(
          `Agent "${agent.name}" references skill "${skillRef}" which was not found in the package.`,
        );
      }
    }
  }

  return { company, agents, skills, errors };
}

// ---------------------------------------------------------------------------
// Idempotent import into supervisor DB
// ---------------------------------------------------------------------------

export interface ImportToDbOptions {
  companyId: string;
  importResult: ImportResult;
  /**
   * Look up existing agents by name within the company.
   * Returns their IDs so we can detect duplicates.
   */
  getExistingAgentsByName: (companyId: string) => Map<string, string>;
  /**
   * Create a new agent in the DB. Returns the new agent's ID.
   */
  createAgent: (agent: {
    companyId: string;
    name: string;
    role: string;
    title: string;
    reportsTo: string | null;
    skills: string[];
    source: string;
  }) => string;
  /**
   * Update an existing agent's skills or metadata (idempotent refresh).
   */
  updateAgent?: (agentId: string, updates: {
    role?: string;
    title?: string;
    skills?: string[];
  }) => void;
}

export interface ImportToDbResult {
  created: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Import parsed package data into the supervisor database.
 * Idempotent: agents matched by name within the same company are skipped.
 */
export function importToDb(options: ImportToDbOptions): ImportToDbResult {
  const { companyId, importResult, getExistingAgentsByName, createAgent, updateAgent } = options;

  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  // Get existing agents for this company
  const existingAgents = getExistingAgentsByName(companyId);

  // Map of new agent names to their IDs (for reportsTo resolution)
  const agentNameToId = new Map<string, string>(existingAgents);
  // Map of directory slugs to their IDs (for slug-based reportsTo resolution)
  const agentSlugToId = new Map<string, string>();

  // First pass: create agents (without reportsTo, since IDs may not exist yet)
  for (const agentDef of importResult.agents) {
    if (existingAgents.has(agentDef.name)) {
      skipped.push(agentDef.name);

      // Track slug for existing agents too (for reportsTo resolution)
      const existingId = existingAgents.get(agentDef.name)!;
      if (agentDef.slug) {
        agentSlugToId.set(agentDef.slug, existingId);
      }

      // Optionally update metadata for existing agents
      if (updateAgent) {
        try {
          updateAgent(existingId, {
            role: agentDef.role,
            title: agentDef.title,
            skills: agentDef.skills,
          });
        } catch (err) {
          errors.push(`Failed to update existing agent "${agentDef.name}": ${errorMessage(err)}`);
        }
      }
      continue;
    }

    try {
      const agentId = createAgent({
        companyId,
        name: agentDef.name,
        role: agentDef.role,
        title: agentDef.title,
        reportsTo: null, // Set in second pass after all agents exist
        skills: agentDef.skills,
        source: "companies-sh",
      });
      created.push(agentDef.name);
      agentNameToId.set(agentDef.name, agentId);
      if (agentDef.slug) {
        agentSlugToId.set(agentDef.slug, agentId);
      }
    } catch (err) {
      errors.push(`Failed to create agent "${agentDef.name}": ${errorMessage(err)}`);
    }
  }

  // Second pass: resolve reportsTo relationships by slug first, then case-insensitive name fallback
  for (const agentDef of importResult.agents) {
    if (!agentDef.reportsTo) continue;

    const agentId = agentNameToId.get(agentDef.name);
    if (!agentId) continue;

    // Try resolving by slug first
    let reportsToId = agentSlugToId.get(agentDef.reportsTo);

    // Fall back to exact name match
    if (!reportsToId) {
      reportsToId = agentNameToId.get(agentDef.reportsTo);
    }

    // Fall back to case-insensitive name match
    if (!reportsToId) {
      const reportsToLower = agentDef.reportsTo.toLowerCase();
      for (const [name, id] of agentNameToId) {
        if (name.toLowerCase() === reportsToLower) {
          reportsToId = id;
          break;
        }
      }
    }

    if (!reportsToId) {
      errors.push(
        `Agent "${agentDef.name}" reports to "${agentDef.reportsTo}" but that agent was not found.`,
      );
      continue;
    }

    if (updateAgent) {
      try {
        updateAgent(agentId, { role: agentDef.role, title: agentDef.title });
      } catch (err) {
        errors.push(`Failed to set reportsTo for "${agentDef.name}": ${errorMessage(err)}`);
      }
    }
  }

  return { created, skipped, errors };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getString(
  fm: Record<string, string | string[]>,
  key: string,
): string | null {
  const val = fm[key];
  if (typeof val === "string") return val;
  if (Array.isArray(val) && val.length > 0) return val[0]!;
  return null;
}

function getStringArray(
  fm: Record<string, string | string[]>,
  key: string,
): string[] {
  const val = fm[key];
  if (Array.isArray(val)) return val;
  if (typeof val === "string" && val) {
    // Try comma-separated values
    return val.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
