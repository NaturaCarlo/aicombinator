import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function parse_json<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

export function parse_json_with_error<T>(raw: string): { ok: true; value: T } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parse_json_array<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function ensure_workspace_agent_dir(workspace_dir: string): string {
  const dir = join(workspace_dir, ".agent");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function calculate_burn_rate_per_hour(spent_24h: number): number {
  return spent_24h / 24;
}

export function minutes_since(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
}
