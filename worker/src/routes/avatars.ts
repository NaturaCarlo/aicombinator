import type { Env } from "../types.js";
import {
  avatarGenerationEnabled,
  generateAgentAvatar,
  resolveFounderCountryContext,
  storeAvatar,
} from "../enrichment/agent-identity.js";

/**
 * GET /api/avatars/:agentId — Serve agent avatar from KV.
 * Falls back to a deterministic SVG portrait immediately so the team never
 * renders broken/missing images while the real avatar is still generating.
 *
 * Lazy regeneration: If the agent has no stored avatar and avatar_generated
 * metadata is false, triggers a background regeneration attempt via ctx.waitUntil
 * so that subsequent requests will serve the real avatar.
 */
export async function handleGetAvatar(
  _request: Request,
  env: Env,
  agentId: string,
  ctx?: ExecutionContext,
): Promise<Response> {
  const { value, metadata } = await env.AUTOMATON_KV.getWithMetadata<{ contentType: string }>(
    `avatar:${agentId}`,
    { type: "arrayBuffer" },
  );

  if (!value) {
    const agent = await env.DB.prepare(
      `SELECT id, name, title, role, company_id, metadata FROM agents WHERE id = ?`,
    ).bind(agentId).first<{
      id: string;
      name: string | null;
      title: string | null;
      role: string | null;
      company_id: string | null;
      metadata: string | null;
    }>();

    const agentName = agent?.name ?? "Agent";
    const agentTitle = agent?.title ?? agent?.role ?? "Team member";

    // Lazy regeneration: attempt avatar generation in the background
    // if the agent exists, has no avatar, and generation is enabled.
    if (agent?.company_id && avatarGenerationEnabled(env)) {
      const agentMeta = parseMetadataSafe(agent.metadata);
      if (!agentMeta.avatar_generated) {
        const lazyRegen = lazyRegenerateAvatar(env, {
          agentId,
          agentName,
          agentTitle,
          companyId: agent.company_id,
        });
        if (ctx) {
          ctx.waitUntil(lazyRegen);
        } else {
          void lazyRegen;
        }
      }
    }

    return new Response(
      buildAvatarFallbackSvg({
        agentId,
        name: agentName,
        title: agentTitle,
      }),
      {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
        },
      },
    );
  }

  return new Response(value, {
    headers: {
      "Content-Type": metadata?.contentType || "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

function parseMetadataSafe(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function lazyRegenerateAvatar(
  env: Env,
  opts: {
    agentId: string;
    agentName: string;
    agentTitle: string;
    companyId: string;
  },
): Promise<void> {
  try {
    const company = await env.DB.prepare(
      `SELECT user_id FROM companies WHERE id = ? LIMIT 1`,
    ).bind(opts.companyId).first<{ user_id: string }>();
    if (!company) return;

    const { country, countryName } = await resolveFounderCountryContext(env, company.user_id);

    const avatarBase64 = await generateAgentAvatar(
      opts.agentName,
      opts.agentTitle,
      countryName,
      env,
      {
        agentId: opts.agentId,
        mode: "automatic",
        countryCode: country,
      },
    );

    if (avatarBase64) {
      const avatarUrl = await storeAvatar(opts.agentId, avatarBase64, env);
      await env.DB.prepare(
        `UPDATE agents
         SET icon = ?,
             metadata = json_set(COALESCE(metadata, '{}'), '$.avatar_generated', 1),
             updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(avatarUrl, opts.agentId).run();
      console.log(`[avatar] Lazy regeneration succeeded for ${opts.agentName} (${opts.agentId})`);
    }
  } catch (err) {
    console.error(
      `[avatar] Lazy regeneration failed for ${opts.agentName} (${opts.agentId}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

function buildAvatarFallbackSvg(input: {
  agentId: string;
  name: string;
  title: string;
}): string {
  const seed = hashString(`${input.agentId}:${input.name}:${input.title}`);
  const palette = pickPalette(seed);
  const initials = buildInitials(input.name);
  const accentX = 72 + (seed % 18);
  const accentY = 38 + (seed % 14);
  const jacketWidth = 104 + (seed % 18);
  const jacketCurve = 80 + (seed % 16);

  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="${escapeXml(input.name)} profile placeholder">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.bgStart}"/>
      <stop offset="100%" stop-color="${palette.bgEnd}"/>
    </linearGradient>
    <linearGradient id="shirt" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${palette.shirtStart}"/>
      <stop offset="100%" stop-color="${palette.shirtEnd}"/>
    </linearGradient>
  </defs>
  <rect width="200" height="200" rx="28" fill="url(#bg)"/>
  <circle cx="${accentX}" cy="${accentY}" r="34" fill="${palette.accent}" opacity="0.22"/>
  <circle cx="100" cy="80" r="34" fill="${palette.face}"/>
  <path d="M65 168c7-28 24-42 35-42 11 0 28 14 35 42" fill="${palette.shirtStart}"/>
  <path d="M48 188c8-29 27-52 52-52 25 0 44 23 52 52" fill="url(#shirt)"/>
  <path d="M62 186c18-24 37-36 38-36s20 12 38 36" fill="${palette.jacket}" opacity="0.96"/>
  <path d="M100 91c-15 0-27-10-31-23 2-13 14-24 31-24s29 11 31 24c-4 13-16 23-31 23z" fill="${palette.hair}"/>
  <path d="M90 114h20l-10 16z" fill="${palette.shirtEnd}" opacity="0.88"/>
  <ellipse cx="100" cy="${168 + (seed % 4)}" rx="${jacketWidth / 2}" ry="${jacketCurve / 2}" fill="${palette.shadow}" opacity="0.16"/>
  <circle cx="44" cy="44" r="21" fill="${palette.badge}" opacity="0.96"/>
  <text x="44" y="51" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" font-weight="700" fill="#fff">${escapeXml(initials)}</text>
</svg>`.trim();
}

function buildInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);

  if (parts.length === 0) {
    return "A";
  }

  return parts.map((part) => part.charAt(0).toUpperCase()).join("");
}

function hashString(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function pickPalette(seed: number) {
  const palettes = [
    {
      bgStart: "#f8eadf",
      bgEnd: "#e8d7c7",
      accent: "#ff9b66",
      face: "#f2d0bc",
      hair: "#40281f",
      shirtStart: "#f4f7fb",
      shirtEnd: "#dce5ef",
      jacket: "#42556c",
      shadow: "#7d8ca0",
      badge: "#ef6b2e",
    },
    {
      bgStart: "#ebeef7",
      bgEnd: "#d6dde9",
      accent: "#8cb7ff",
      face: "#f0c9ad",
      hair: "#2a2423",
      shirtStart: "#f8fbff",
      shirtEnd: "#dce7f5",
      jacket: "#314966",
      shadow: "#5c6f89",
      badge: "#5177c8",
    },
    {
      bgStart: "#efe5e0",
      bgEnd: "#e2d0c8",
      accent: "#ffb18b",
      face: "#f3d8c5",
      hair: "#51372a",
      shirtStart: "#ffffff",
      shirtEnd: "#ece6df",
      jacket: "#6a4e42",
      shadow: "#8e7264",
      badge: "#cc774d",
    },
    {
      bgStart: "#edf4ef",
      bgEnd: "#d7e5da",
      accent: "#8fc3a5",
      face: "#efc7aa",
      hair: "#2d2825",
      shirtStart: "#f9fcfa",
      shirtEnd: "#d9e8df",
      jacket: "#365046",
      shadow: "#688278",
      badge: "#4e9b74",
    },
  ] as const;

  return palettes[seed % palettes.length];
}

function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}
