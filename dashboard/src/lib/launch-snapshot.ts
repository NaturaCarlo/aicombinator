"use client";

import type {
  Agent,
  CompanyArtifact,
  CompanyDocument,
  CompanyStatus,
  Task,
} from "./types";

const STORAGE_PREFIX = "launch-snapshot:";
const MAX_SNAPSHOT_AGE_MS = 2 * 60 * 1000;

export interface LaunchSnapshot {
  capturedAt: string;
  status: CompanyStatus;
  agents: Agent[];
  tasks: Task[];
  documents: CompanyDocument[];
  artifacts: CompanyArtifact[];
}

function storageKey(companyId: string): string {
  return `${STORAGE_PREFIX}${companyId}`;
}

export function saveLaunchSnapshot(snapshot: LaunchSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(
      storageKey(snapshot.status.companyId),
      JSON.stringify(snapshot),
    );
  } catch {
    // Ignore snapshot persistence failures; launch should still continue.
  }
}

export function consumeLaunchSnapshot(companyId: string): LaunchSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(storageKey(companyId));
    if (!raw) {
      return null;
    }
    window.sessionStorage.removeItem(storageKey(companyId));
    const parsed = JSON.parse(raw) as LaunchSnapshot;
    const capturedAt = new Date(parsed.capturedAt).getTime();
    if (!Number.isFinite(capturedAt) || (Date.now() - capturedAt) > MAX_SNAPSHOT_AGE_MS) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

