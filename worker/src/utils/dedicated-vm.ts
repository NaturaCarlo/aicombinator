import type { CompanyRow, Env } from "../types.js";
import { dedicatedSupervisorBaseUrl, sharedSupervisorBaseUrl } from "./supervisor-routing.js";

const HETZNER_API_URL = "https://api.hetzner.cloud/v1";
const DEDICATED_VM_SERVER_TYPE = "cpx21";
const DEDICATED_VM_IMAGE = "ubuntu-24.04";
const DEDICATED_VM_LOCATION = "ash";
const AUTOMATON_REPO_URL = "https://github.com/Conway-Research/automaton.git";
const AUTOMATON_REPO_REF = "main";

export type UserDedicatedVmRecord = {
  status: "pending" | "provisioning" | "active" | "failed" | "shared";
  serverId: string | null;
  serverIp: string | null;
};

type HetznerServerCreateResponse = {
  server?: {
    id?: number;
    name?: string;
    public_net?: {
      ipv4?: {
        ip?: string | null;
      } | null;
    } | null;
  };
};

type HetznerServerListResponse = {
  servers?: Array<{
    id?: number;
    name?: string;
    public_net?: {
      ipv4?: {
        ip?: string | null;
      } | null;
    } | null;
  }>;
};

export async function listUserDedicatedCompanies(
  env: Env,
  userId: string,
): Promise<CompanyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT *
     FROM companies
     WHERE user_id = ?
       AND runtime_tier = 'dedicated'
       AND state NOT IN ('dead', 'failed')
     ORDER BY created_at ASC`,
  ).bind(userId).all<CompanyRow>();

  return results ?? [];
}

export async function getUserDedicatedVmRecord(
  env: Env,
  userId: string,
): Promise<UserDedicatedVmRecord | null> {
  const row = await env.DB.prepare(
    `SELECT dedicated_vm_status, dedicated_vm_id, dedicated_vm_ip
     FROM companies
     WHERE user_id = ?
       AND runtime_tier = 'dedicated'
       AND dedicated_vm_status IN ('pending', 'provisioning', 'active', 'failed')
     ORDER BY CASE dedicated_vm_status
       WHEN 'active' THEN 0
       WHEN 'provisioning' THEN 1
       WHEN 'pending' THEN 2
       ELSE 3
     END,
     updated_at DESC
     LIMIT 1`,
  )
    .bind(userId)
    .first<{
      dedicated_vm_status: UserDedicatedVmRecord["status"];
      dedicated_vm_id: string | null;
      dedicated_vm_ip: string | null;
    }>();

  if (!row) {
    return null;
  }

  return {
    status: row.dedicated_vm_status,
    serverId: row.dedicated_vm_id,
    serverIp: row.dedicated_vm_ip,
  };
}

export async function setUserDedicatedVmState(
  env: Env,
  userId: string,
  patch: {
    status: UserDedicatedVmRecord["status"];
    serverId?: string | null;
    serverIp?: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE companies
     SET dedicated_vm_status = ?,
         dedicated_vm_id = COALESCE(?2, dedicated_vm_id),
         dedicated_vm_ip = COALESCE(?3, dedicated_vm_ip),
         updated_at = datetime('now')
     WHERE user_id = ?
       AND runtime_tier = 'dedicated'`,
  )
    .bind(patch.status, patch.serverId ?? null, patch.serverIp ?? null, userId)
    .run();
}

export async function ensureDedicatedVmForUser(
  env: Env,
  userId: string,
): Promise<UserDedicatedVmRecord> {
  const existing = await getUserDedicatedVmRecord(env, userId);
  if (existing && (existing.status === "active" || existing.status === "provisioning")) {
    return existing;
  }

  const companies = await listUserDedicatedCompanies(env, userId);
  if (companies.length === 0) {
    return {
      status: "shared",
      serverId: null,
      serverIp: null,
    };
  }

  const server = await createDedicatedVm(env, userId, companies);
  const record: UserDedicatedVmRecord = {
    status: "provisioning",
    serverId: server.serverId,
    serverIp: server.serverIp,
  };

  await setUserDedicatedVmState(env, userId, {
    status: "provisioning",
    serverId: server.serverId,
    serverIp: server.serverIp,
  });

  return record;
}

export async function resolveHetznerServerByName(
  env: Env,
  serverName: string,
): Promise<{ serverId: string | null; serverIp: string | null }> {
  if (!env.HETZNER_API_TOKEN) {
    return { serverId: null, serverIp: null };
  }

  const response = await fetch(`${HETZNER_API_URL}/servers`, {
    headers: {
      Authorization: `Bearer ${env.HETZNER_API_TOKEN}`,
    },
  });

  if (!response.ok) {
    return { serverId: null, serverIp: null };
  }

  const payload = await response.json() as HetznerServerListResponse;
  const match = payload.servers?.find((server) => server.name === serverName);

  return {
    serverId: match?.id ? String(match.id) : null,
    serverIp: match?.public_net?.ipv4?.ip ?? null,
  };
}

async function createDedicatedVm(
  env: Env,
  userId: string,
  companies: CompanyRow[],
): Promise<{ serverId: string; serverIp: string | null }> {
  if (!env.HETZNER_API_TOKEN) {
    throw new Error("HETZNER_API_TOKEN is not configured");
  }

  const primaryCompany = companies[0];
  const serverName = buildDedicatedVmServerName(primaryCompany, userId);
  const userData = buildDedicatedVmUserData(env, {
    userId,
    serverName,
  });

  const response = await fetch(`${HETZNER_API_URL}/servers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.HETZNER_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: serverName,
      server_type: DEDICATED_VM_SERVER_TYPE,
      image: DEDICATED_VM_IMAGE,
      location: DEDICATED_VM_LOCATION,
      user_data: userData,
    }),
  });

  const raw = await response.text();
  let parsed: HetznerServerCreateResponse | null = null;
  try {
    parsed = raw ? JSON.parse(raw) as HetznerServerCreateResponse : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new Error(raw || `Hetzner create server failed with ${response.status}`);
  }

  const serverId = parsed?.server?.id;
  if (!serverId) {
    throw new Error("Hetzner create server response did not include a server id");
  }

  return {
    serverId: String(serverId),
    serverIp: parsed?.server?.public_net?.ipv4?.ip ?? null,
  };
}

function buildDedicatedVmServerName(company: CompanyRow, userId: string): string {
  const base = (company.slug || company.name || "company")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "company";
  const suffix = userId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6) || "user";
  return `aic-${base}-${suffix}`;
}

function buildDedicatedVmUserData(
  env: Env,
  input: {
    userId: string;
    serverName: string;
  },
): string {
  const workerApiUrl = env.WORKER_API_URL.replace(/\/+$/, "");
  const envFile = [
    `WORKER_API_URL=${workerApiUrl}`,
    `INTERNAL_API_KEY=${env.SUPERVISOR_API_KEY}`,
    `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY}`,
    "PORT=8787",
    "CACHE_REFRESH_MS=5000",
    "STATE_SYNC_MS=10000",
    "CRON_CHECK_MS=30000",
    "COMPANIES_DIR=/srv/aicombinator/companies",
    "MCP_SERVERS_DIR=/srv/aicombinator/mcp-servers",
    "DOCKER_NETWORK=aicombinator",
    "RELAY_ENABLED=false",
    "LOCAL_STATE_DB_PATH=/srv/aicombinator/supervisor-state.sqlite",
    `DEDICATED_USER_ID=${input.userId}`,
  ].join("\n");

  return [
    "#cloud-config",
    "write_files:",
    "  - path: /usr/local/bin/aic-bootstrap.sh",
    "    permissions: '0755'",
    "    owner: root:root",
    "    content: |",
    "      #!/usr/bin/env bash",
    "      set -euo pipefail",
    "      export DEBIAN_FRONTEND=noninteractive",
    "      apt-get update -qq",
    "      apt-get install -y -qq git rsync",
    "      rm -rf /tmp/automaton-src",
    `      git clone --depth 1 --branch ${AUTOMATON_REPO_REF} ${AUTOMATON_REPO_URL} /tmp/automaton-src`,
    "      mkdir -p /srv/aicombinator/supervisor /srv/aicombinator/deploy",
    "      rsync -a /tmp/automaton-src/supervisor/ /srv/aicombinator/supervisor/",
    "      rsync -a /tmp/automaton-src/deploy/ /srv/aicombinator/deploy/",
    "      ALLOW_SUPERVISOR_PORT=1 bash /srv/aicombinator/deploy/setup-vm.sh",
    "      cat >/srv/aicombinator/supervisor/.env <<'EOF'",
    ...envFile.split("\n").map((line) => `      ${line}`),
    "      EOF",
    "      chown aicombinator:aicombinator /srv/aicombinator/supervisor/.env",
    "      su - aicombinator -c 'cd /srv/aicombinator/supervisor && npm ci'",
    "      su - aicombinator -c 'cd /srv/aicombinator/supervisor && npm run build'",
    "      cp /srv/aicombinator/deploy/aicombinator-supervisor.service /etc/systemd/system/aicombinator-supervisor.service",
    "      systemctl daemon-reload",
    "      systemctl enable aicombinator-supervisor",
    "      systemctl restart aicombinator-supervisor",
    "      for _ in $(seq 1 60); do",
    "        if curl -sf http://127.0.0.1:8787/health >/dev/null; then break; fi",
    "        sleep 5",
    "      done",
    "      SERVER_IP=$(hostname -I | awk '{print $1}')",
    `      curl -sf -X POST ${workerApiUrl}/api/supervisor/dedicated-vm/register \\`,
    "        -H 'Content-Type: application/json' \\",
    `        -H 'X-Supervisor-Key: ${env.SUPERVISOR_API_KEY}' \\`,
    "        --data-binary @- <<EOF",
    `      {"userId":"${input.userId}","serverName":"${input.serverName}","serverIp":"\${SERVER_IP}"}`,
    "      EOF",
    "runcmd:",
    "  - /usr/local/bin/aic-bootstrap.sh",
  ].join("\n");
}

export async function migrateCompanyWorkspaceToDedicatedVm(
  env: Env,
  company: Pick<CompanyRow, "id" | "name">,
  dedicatedVmIp: string,
): Promise<void> {
  const sharedBaseUrl = await sharedSupervisorBaseUrl(env);
  if (!sharedBaseUrl) {
    throw new Error("Shared supervisor URL is not configured");
  }

  const dedicatedBaseUrl = dedicatedSupervisorBaseUrl(dedicatedVmIp);
  const headers = {
    "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
    "Content-Type": "application/json",
  };

  await fetch(`${sharedBaseUrl}/companies/${company.id}/pause`, {
    method: "POST",
    headers,
  }).catch(() => {});

  const archiveResponse = await fetch(
    `${sharedBaseUrl}/companies/${company.id}/workspace/archive`,
    { headers },
  );
  if (!archiveResponse.ok) {
    throw new Error(`Failed to export workspace archive for ${company.id}`);
  }

  const ensureRuntimeResponse = await fetch(
    `${dedicatedBaseUrl}/companies/${company.id}/runtime/ensure`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ companyName: company.name }),
    },
  );
  if (!ensureRuntimeResponse.ok) {
    throw new Error(`Failed to ensure dedicated runtime for ${company.id}`);
  }

  const importResponse = await fetch(
    `${dedicatedBaseUrl}/companies/${company.id}/workspace/archive`,
    {
      method: "POST",
      headers: {
        "X-Supervisor-Key": env.SUPERVISOR_API_KEY,
        "Content-Type": "application/gzip",
      },
      body: await archiveResponse.arrayBuffer(),
    },
  );
  if (!importResponse.ok) {
    throw new Error(`Failed to import workspace archive for ${company.id}`);
  }
}
