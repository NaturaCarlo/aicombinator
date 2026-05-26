"use client";

import type { LaunchSessionMode } from "./types";

const LAUNCH_DRAFT_KEY = "launch-draft";
const PENDING_LAUNCH_KEY = "pending-launch";
const MAX_DRAFT_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_PENDING_AGE_MS = 30 * 60 * 1000;

export type LaunchStepState = "idea" | "session" | "provisioning";

export interface LaunchDraftState {
  companyName: string;
  idea: string;
  mode: LaunchSessionMode;
  launchSessionId?: string | null;
  step: LaunchStepState;
  updatedAt: string;
}

export interface PendingLaunchState {
  companyId: string;
  companyName: string;
  idea: string;
  mode: LaunchSessionMode;
  launchSessionId?: string | null;
  step: LaunchStepState;
  createdAt: string;
  updatedAt: string;
}

function readJson<T>(key: string, maxAgeMs: number): T | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as { updatedAt?: string };
    const updatedAt = parsed.updatedAt ? new Date(parsed.updatedAt).getTime() : NaN;

    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maxAgeMs) {
      window.sessionStorage.removeItem(key);
      return null;
    }

    return parsed as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures. Launch should still work.
  }
}

function clearKey(key: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

export function loadLaunchDraft(): LaunchDraftState | null {
  return readJson<LaunchDraftState>(LAUNCH_DRAFT_KEY, MAX_DRAFT_AGE_MS);
}

export function saveLaunchDraft(input: Omit<LaunchDraftState, "updatedAt">): void {
  writeJson(LAUNCH_DRAFT_KEY, {
    ...input,
    updatedAt: new Date().toISOString(),
  } satisfies LaunchDraftState);
}

export function clearLaunchDraft(): void {
  clearKey(LAUNCH_DRAFT_KEY);
}

export function loadPendingLaunch(): PendingLaunchState | null {
  return readJson<PendingLaunchState>(PENDING_LAUNCH_KEY, MAX_PENDING_AGE_MS);
}

export function savePendingLaunch(input: Omit<PendingLaunchState, "updatedAt">): void {
  writeJson(PENDING_LAUNCH_KEY, {
    ...input,
    updatedAt: new Date().toISOString(),
  } satisfies PendingLaunchState);
}

export function clearPendingLaunch(): void {
  clearKey(PENDING_LAUNCH_KEY);
}
