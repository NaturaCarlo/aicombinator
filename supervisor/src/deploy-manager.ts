/**
 * Deploy Manager — Serves company workspaces at {slug}.aicombinator.live.
 *
 * Architecture:
 *   DNS: *.aicombinator.live → VM IP (Cloudflare A record)
 *   nginx (host, port 80) → localhost:{port} per company
 *   Each company runs a web server process on a unique port (10000+).
 *
 * For each company:
 *   1. Detect app type (static HTML, Node.js, or nothing)
 *   2. Allocate a unique port
 *   3. Start web server as a host child process (or via docker exec if container exists)
 *   4. Generate an nginx server block
 *   5. Reload nginx
 *
 * Deploy is triggered automatically after task completion. Static file
 * changes are live immediately (served from disk). Node.js apps are
 * restarted on each deploy to pick up code changes.
 */

import { exec as execCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { SupervisorDb, isoNow } from "./db.js";
import type { CompanyRow, SupervisorConfig } from "./types.js";

const exec = promisify(execCb);

export type HostingType = "static" | "nodejs" | "none";
export type HostingStatus = "none" | "deploying" | "active" | "stopped" | "error";

const BASE_PORT = 10000;
const NGINX_CONF_DIR = "/etc/nginx/conf.d";

/** Directories checked for static HTML files, in priority order. */
const STATIC_DIRS = [
  "src/landing",
  "src/frontend",
  "src",
  "public",
  "website",
  "landing",
  "dist",
  "build",
  "out",
  "artifacts/landing",
];

export class DeployManager {
  private readonly domain: string;
  private readonly companiesDir: string;
  /** Track running child processes so we can kill them on redeploy/undeploy. */
  private readonly processes = new Map<string, number>(); // companyId → PID

  constructor(
    private readonly db: SupervisorDb,
    private readonly config: SupervisorConfig,
  ) {
    this.domain = "aicombinator.live";
    this.companiesDir = config.containerConfig.companiesDir;
  }

  // ─── Public API ────────────────────────────────────────────────

  /**
   * Check workspace and deploy if deployable content exists.
   * Called after task completion — non-blocking, logs errors.
   */
  async maybe_deploy(company: CompanyRow): Promise<void> {
    if (!company.workspace_dir) return;
    if (company.state === "dead" || company.state === "failed") return;

    const hosting_type = this.detect_app_type(company.workspace_dir);
    if (hosting_type === "none") return;

    const current_status = this.get_hosting_status(company.id);

    // Already deployed with same type — skip for static (changes are live),
    // but for Node.js we restart to pick up code changes.
    if (current_status === "active") {
      const current_type = this.get_hosting_type(company.id);
      if (current_type === hosting_type && hosting_type === "static") return;
    }

    await this.deploy(company, hosting_type);
  }

  /**
   * Deploy a company's workspace.
   */
  async deploy(company: CompanyRow, hosting_type?: HostingType): Promise<void> {
    if (!company.workspace_dir) return;

    const type = hosting_type ?? this.detect_app_type(company.workspace_dir);
    if (type === "none") return;

    const slug = this.slugify(company.name);
    const port = this.allocate_port(company.id);
    console.log(
      `[deploy] Deploying ${company.name} (${company.id}) as ${type} → ${slug}.${this.domain} on port ${port}`,
    );

    this.update_hosting(company.id, "deploying", type, slug, port);

    try {
      // 1. Stop any existing server for this company
      await this.stop_app_server(company.id);

      // 2. Start web server
      await this.start_app_server(company.id, company.workspace_dir, type, port);

      // 3. Write nginx config for this company's subdomain
      this.write_nginx_config(company.id, slug, port);

      // 4. Reload nginx
      await this.reload_nginx();

      this.update_hosting(company.id, "active", type, slug, port);
      console.log(`[deploy] ${slug}.${this.domain} is live (port ${port})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[deploy] Failed for ${company.id}: ${msg}`);
      this.update_hosting(company.id, "error", type, slug, port);
    }
  }

  /**
   * Stop hosting for a company.
   */
  async undeploy(company_id: string): Promise<void> {
    console.log(`[deploy] Undeploying ${company_id}`);

    await this.stop_app_server(company_id);
    this.remove_nginx_config(company_id);

    try {
      await this.reload_nginx();
    } catch {
      /* nginx may not be running */
    }

    this.update_hosting(company_id, "stopped", "none", null, null);
  }

  /**
   * Re-start servers for all previously-deployed companies.
   * Called on supervisor startup.
   */
  async redeploy_all(): Promise<void> {
    const companies = this.db.all<
      CompanyRow & { hosting_slug: string; hosting_type: string; hosting_port: number }
    >(
      `SELECT * FROM companies WHERE hosting_status = 'active'`,
    );

    if (companies.length === 0) return;

    console.log(`[deploy] Re-deploying ${companies.length} companies`);

    // Also recover any previously-running processes from PID files
    for (const company of companies) {
      if (!company.workspace_dir) continue;
      this.recover_pid(company.id, company.workspace_dir);
    }

    let any_config_written = false;
    for (const company of companies) {
      if (!company.workspace_dir) continue;
      const type = this.detect_app_type(company.workspace_dir);
      if (type === "none") continue;

      const port = company.hosting_port || this.allocate_port(company.id);
      const slug = company.hosting_slug ?? this.slugify(company.name);

      try {
        // Check if the process is still alive
        const alive = this.is_process_alive(company.id);
        if (!alive) {
          await this.start_app_server(company.id, company.workspace_dir, type, port);
        }

        this.write_nginx_config(company.id, slug, port);
        any_config_written = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[deploy] Redeploy failed for ${company.id}: ${msg}`);
      }
    }

    if (any_config_written) {
      try {
        await this.reload_nginx();
      } catch (err) {
        console.error(`[deploy] nginx reload failed after redeploy:`, err);
      }
    }
  }

  // ─── App Type Detection ────────────────────────────────────────

  /**
   * Detect what kind of app is in the workspace.
   *   - "nodejs"  — package.json with start script, or server.js/app.js
   *   - "static"  — HTML files in a known directory
   *   - "none"    — nothing deployable
   */
  detect_app_type(workspace_dir: string): HostingType {
    // Check for Node.js app first
    const pkgPath = join(workspace_dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          scripts?: Record<string, string>;
        };
        if (pkg.scripts?.start || pkg.scripts?.serve) {
          return "nodejs";
        }
      } catch {
        /* not valid JSON */
      }
    }

    // Check for standalone server files
    for (const name of ["server.js", "app.js"]) {
      if (existsSync(join(workspace_dir, name))) {
        return "nodejs";
      }
    }

    // Check for static files in known directories
    for (const dir of STATIC_DIRS) {
      const fullPath = join(workspace_dir, dir);
      if (existsSync(fullPath) && this.has_html_files(fullPath)) {
        return "static";
      }
    }

    // Check root for index.html
    if (existsSync(join(workspace_dir, "index.html"))) {
      return "static";
    }

    return "none";
  }

  private has_html_files(dir: string): boolean {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      return entries.some(
        (e) =>
          e.isFile() && (e.name.endsWith(".html") || e.name.endsWith(".htm")),
      );
    } catch {
      return false;
    }
  }

  // ─── Web Server Process Management ─────────────────────────────

  private async start_app_server(
    company_id: string,
    workspace_dir: string,
    type: HostingType,
    port: number,
  ): Promise<void> {
    if (type === "static") {
      const serve_root = this.find_static_root(workspace_dir);
      const server_script = this.build_static_server_script(serve_root, port);
      const script_path = join(workspace_dir, ".deploy-server.mjs");
      writeFileSync(script_path, server_script);

      const child = spawn("node", [script_path], {
        cwd: workspace_dir,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PORT: String(port) },
      });
      child.unref();

      if (child.pid) {
        this.processes.set(company_id, child.pid);
        this.write_pid_file(workspace_dir, child.pid);
        console.log(`[deploy] Static server started (PID ${child.pid}, port ${port})`);
      }
    } else if (type === "nodejs") {
      const pkgPath = join(workspace_dir, "package.json");

      // Install dependencies if package.json exists
      if (existsSync(pkgPath)) {
        try {
          await exec("npm install --production 2>&1 | tail -5", {
            cwd: workspace_dir,
            timeout: 120_000,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[deploy] npm install warning for ${company_id}: ${msg}`);
        }
      }

      // Determine the start command — run node directly to avoid npm wrapper issues
      let cmd: string;
      let args: string[];

      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
            scripts?: Record<string, string>;
            main?: string;
          };
          const startScript = pkg.scripts?.start || pkg.scripts?.serve;
          // If start script is a simple "node <file>" command, run it directly
          const nodeMatch = startScript?.match(/^node\s+(.+)$/);
          if (nodeMatch) {
            cmd = "node";
            args = nodeMatch[1].trim().split(/\s+/);
          } else if (pkg.main && existsSync(join(workspace_dir, pkg.main))) {
            cmd = "node";
            args = [pkg.main];
          } else {
            cmd = "npm";
            args = ["start"];
          }
        } catch {
          cmd = "npm";
          args = ["start"];
        }
      } else if (existsSync(join(workspace_dir, "server.js"))) {
        cmd = "node";
        args = ["server.js"];
      } else {
        cmd = "node";
        args = ["app.js"];
      }

      const child = spawn(cmd, args, {
        cwd: workspace_dir,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PORT: String(port), NODE_ENV: "production" },
      });
      child.unref();

      if (child.pid) {
        this.processes.set(company_id, child.pid);
        this.write_pid_file(workspace_dir, child.pid);
        console.log(`[deploy] Node.js app started (PID ${child.pid}, port ${port})`);
      }
    }

    // Brief wait for the server to bind
    await new Promise((r) => setTimeout(r, 2_000));
  }

  private async stop_app_server(company_id: string): Promise<void> {
    const pid = this.processes.get(company_id);
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
        // Give it a moment to shut down
        await new Promise((r) => setTimeout(r, 500));
        try {
          process.kill(pid, 0); // Check if still alive
          process.kill(pid, "SIGKILL"); // Force kill
        } catch {
          /* already dead */
        }
      } catch {
        /* process may not exist */
      }
      this.processes.delete(company_id);
    }

    // Also try to kill by PID file (in case supervisor restarted)
    const company = this.db.get<CompanyRow>(
      `SELECT * FROM companies WHERE id = ?`,
      [company_id],
    );
    if (company?.workspace_dir) {
      const pid_file = join(company.workspace_dir, ".deploy.pid");
      if (existsSync(pid_file)) {
        try {
          const stored_pid = parseInt(readFileSync(pid_file, "utf-8").trim(), 10);
          if (stored_pid > 0) {
            try {
              process.kill(stored_pid, "SIGTERM");
            } catch {
              /* process may not exist */
            }
          }
          unlinkSync(pid_file);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private find_static_root(workspace_dir: string): string {
    // First check if any directory has an index.html
    for (const dir of STATIC_DIRS) {
      const fullPath = join(workspace_dir, dir);
      if (existsSync(join(fullPath, "index.html"))) {
        return fullPath;
      }
    }

    // Then check for any HTML files
    for (const dir of STATIC_DIRS) {
      const fullPath = join(workspace_dir, dir);
      if (existsSync(fullPath) && this.has_html_files(fullPath)) {
        return fullPath;
      }
    }

    // Fall back to workspace root
    return workspace_dir;
  }

  private build_static_server_script(serve_root: string, port: number): string {
    return `// Auto-generated static file server for AI Combinator hosting
// Do not edit — regenerated on each deploy.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";

const PORT = ${port};
const ROOT = ${JSON.stringify(serve_root)};

const MIME = {
  ".html": "text/html", ".htm": "text/html",
  ".css": "text/css",
  ".js": "application/javascript", ".mjs": "application/javascript",
  ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".txt": "text/plain", ".xml": "application/xml",
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".pdf": "application/pdf",
};

async function tryRead(path) {
  try { return await readFile(path); } catch { return null; }
}

const server = createServer(async (req, res) => {
  try {
    let pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname.endsWith("/")) pathname += "index.html";

    const filePath = join(ROOT, pathname);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403); res.end("Forbidden"); return;
    }

    let data = await tryRead(filePath);

    if (!data) {
      const s = await stat(filePath).catch(() => null);
      if (s?.isDirectory()) data = await tryRead(join(filePath, "index.html"));
    }

    if (!data) data = await tryRead(filePath + ".html");

    if (!data) {
      const rootIndex = await tryRead(join(ROOT, "index.html"));
      if (rootIndex && !extname(pathname)) {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache" });
        res.end(rootIndex);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<h1>404 Not Found</h1>");
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";
    const cacheControl = ext === ".html" ? "no-cache" : "public, max-age=3600";
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": cacheControl });
    res.end(data);
  } catch {
    res.writeHead(500); res.end("Internal Server Error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[deploy-server] Serving " + ROOT + " on :" + PORT);
});
`;
  }

  // ─── PID tracking ──────────────────────────────────────────────

  private write_pid_file(workspace_dir: string, pid: number): void {
    writeFileSync(join(workspace_dir, ".deploy.pid"), String(pid));
  }

  private recover_pid(company_id: string, workspace_dir: string): void {
    const pid_file = join(workspace_dir, ".deploy.pid");
    if (!existsSync(pid_file)) return;
    try {
      const pid = parseInt(readFileSync(pid_file, "utf-8").trim(), 10);
      if (pid > 0) {
        process.kill(pid, 0); // Check if alive (throws if not)
        this.processes.set(company_id, pid);
        console.log(`[deploy] Recovered running process for ${company_id} (PID ${pid})`);
      }
    } catch {
      // Process is dead — PID file is stale
      try {
        unlinkSync(pid_file);
      } catch {
        /* ignore */
      }
    }
  }

  private is_process_alive(company_id: string): boolean {
    const pid = this.processes.get(company_id);
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      this.processes.delete(company_id);
      return false;
    }
  }

  // ─── nginx management (host-based) ────────────────────────────

  private write_nginx_config(
    company_id: string,
    slug: string,
    port: number,
  ): void {
    const conf_path = join(NGINX_CONF_DIR, `aic-${company_id}.conf`);
    writeFileSync(
      conf_path,
      `# Auto-generated by supervisor deploy-manager
# Company: ${company_id} → ${slug}.${this.domain} → localhost:${port}
server {
    listen 80;
    server_name ${slug}.${this.domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
    }
}
`,
    );
  }

  private remove_nginx_config(company_id: string): void {
    const path = join(NGINX_CONF_DIR, `aic-${company_id}.conf`);
    try {
      unlinkSync(path);
    } catch {
      /* file may not exist */
    }
  }

  private async reload_nginx(): Promise<void> {
    try {
      await exec("sudo nginx -t && sudo nginx -s reload", { timeout: 10_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[deploy] nginx reload failed: ${msg}`);
    }
  }

  // ─── Port allocation ──────────────────────────────────────────

  private allocate_port(company_id: string): number {
    // Check if this company already has a port
    const existing = this.db.get<{ hosting_port: number | null }>(
      `SELECT hosting_port FROM companies WHERE id = ?`,
      [company_id],
    );
    if (existing?.hosting_port && existing.hosting_port >= BASE_PORT) {
      return existing.hosting_port;
    }

    // Find the highest allocated port
    const max_row = this.db.get<{ max_port: number | null }>(
      `SELECT MAX(hosting_port) as max_port FROM companies WHERE hosting_port IS NOT NULL`,
    );
    const next_port = Math.max(BASE_PORT, (max_row?.max_port ?? BASE_PORT - 1) + 1);

    return next_port;
  }

  // ─── DB helpers ────────────────────────────────────────────────

  get_hosting_status(company_id: string): HostingStatus {
    const row = this.db.get<{ hosting_status: string | null }>(
      `SELECT hosting_status FROM companies WHERE id = ?`,
      [company_id],
    );
    return (row?.hosting_status as HostingStatus) ?? "none";
  }

  private get_hosting_type(company_id: string): HostingType {
    const row = this.db.get<{ hosting_type: string | null }>(
      `SELECT hosting_type FROM companies WHERE id = ?`,
      [company_id],
    );
    return (row?.hosting_type as HostingType) ?? "none";
  }

  get_hosting_slug(company_id: string): string | null {
    const row = this.db.get<{ hosting_slug: string | null }>(
      `SELECT hosting_slug FROM companies WHERE id = ?`,
      [company_id],
    );
    return row?.hosting_slug ?? null;
  }

  private update_hosting(
    company_id: string,
    status: HostingStatus,
    type: HostingType | "none",
    slug: string | null,
    port: number | null,
  ): void {
    this.db.run(
      `UPDATE companies
       SET hosting_status = ?, hosting_type = ?, hosting_slug = ?, hosting_port = ?, updated_at = ?
       WHERE id = ?`,
      [status, type, slug, port, isoNow(), company_id],
    );
    this.db.enqueue_sync("companies", company_id, "upsert", {
      hosting_status: status,
      hosting_type: type,
      hosting_slug: slug,
    });
  }

  // ─── Utility ───────────────────────────────────────────────────

  slugify(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 63) || "app"
    );
  }
}
