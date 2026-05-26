"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live";

const ADAPTER_TYPE_OPTIONS = [
  { value: "http-webhook", label: "HTTP Webhook" },
  { value: "bash", label: "Bash Script" },
  { value: "codex", label: "Codex" },
] as const;

type AdapterType = (typeof ADAPTER_TYPE_OPTIONS)[number]["value"];

interface InviteExternalAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  onSuccess: () => void;
}

export function InviteExternalAgentModal({
  open,
  onOpenChange,
  companyId,
  onSuccess,
}: InviteExternalAgentModalProps) {
  const { getToken } = useAuth();
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [adapterType, setAdapterType] = useState<AdapterType>("http-webhook");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetForm() {
    setName("");
    setRole("");
    setWebhookUrl("");
    setAdapterType("http-webhook");
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const token = await getToken();
      if (!token) {
        setError("Not authenticated");
        return;
      }

      const res = await fetch(
        `${API_URL}/api/companies/${companyId}/agents/external`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            name: name.trim(),
            role: role.trim() || undefined,
            webhookUrl: webhookUrl.trim(),
            adapterType,
          }),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const message =
          (body as { error?: string } | null)?.error ||
          `Request failed (${res.status})`;
        setError(message);
        return;
      }

      resetForm();
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected error occurred");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetForm();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite External Agent</DialogTitle>
          <DialogDescription>
            Register an external agent that will receive task payloads via
            webhook.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Agent Name */}
          <div className="space-y-1.5">
            <label
              htmlFor="agent-name"
              className="text-xs font-medium text-muted-foreground"
            >
              Agent Name
            </label>
            <Input
              id="agent-name"
              placeholder="e.g. Data Analyst"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>

          {/* Role */}
          <div className="space-y-1.5">
            <label
              htmlFor="agent-role"
              className="text-xs font-medium text-muted-foreground"
            >
              Role
            </label>
            <Input
              id="agent-role"
              placeholder="e.g. Specialist"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
          </div>

          {/* Webhook URL */}
          <div className="space-y-1.5">
            <label
              htmlFor="webhook-url"
              className="text-xs font-medium text-muted-foreground"
            >
              Webhook URL
            </label>
            <Input
              id="webhook-url"
              type="url"
              placeholder="https://example.com/agent/webhook"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              required
            />
          </div>

          {/* Adapter Type */}
          <div className="space-y-1.5">
            <label
              htmlFor="adapter-type"
              className="text-xs font-medium text-muted-foreground"
            >
              Adapter Type
            </label>
            <select
              id="adapter-type"
              value={adapterType}
              onChange={(e) => setAdapterType(e.target.value as AdapterType)}
              className="h-9 w-full rounded-none border border-input bg-transparent px-3 py-1 text-sm shadow-none outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] dark:bg-input/30"
            >
              {ADAPTER_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Error message */}
          {error && (
            <p className="text-xs text-red-500" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={submitting || !name.trim() || !webhookUrl.trim()}
              className="bg-accent-orange text-white hover:bg-accent-orange/90"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Creating…
                </>
              ) : (
                "Add Agent"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
