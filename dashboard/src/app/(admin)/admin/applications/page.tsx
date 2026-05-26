"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  FileText,
  CheckCircle2,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Loader2,
  ExternalLink,
  Trash2,
} from "lucide-react";
import { useAdminApplications } from "@/hooks/use-admin";
import { adminUpdateApplication, adminDeleteApplication } from "@/lib/api";
import type { AdminApplication } from "@/lib/types";

const STATUS_TABS = [
  { value: undefined, label: "All" },
  { value: "submitted", label: "Submitted" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
] as const;

export default function AdminApplicationsPage() {
  const [statusFilter, setStatusFilter] = useState<string | undefined>("submitted");
  const { data, isLoading, mutate } = useAdminApplications(statusFilter);
  const { getToken } = useAuth();

  const applications = data?.applications || [];

  return (
    <div className="fade-in-up">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Applications</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Review Genesis Batch applications
        </p>
      </div>

      {/* Status filter tabs */}
      <div className="mb-6 flex gap-1 rounded-none bg-secondary p-1">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.label}
            onClick={() => setStatusFilter(tab.value)}
            className={`rounded-none px-4 py-1.5 text-sm font-medium transition-all ${
              statusFilter === tab.value
                ? "bg-white text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : applications.length === 0 ? (
        <div className="card-clean flex flex-col items-center justify-center py-20">
          <FileText className="mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">
            No applications found
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {applications.map((app) => (
            <ApplicationRow
              key={app.id}
              app={app}
              getToken={getToken}
              onUpdate={() => mutate()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ApplicationRow({
  app,
  getToken,
  onUpdate,
}: {
  app: AdminApplication;
  getToken: () => Promise<string | null>;
  onUpdate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleAction(status: "accepted" | "rejected") {
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      await adminUpdateApplication(
        app.id,
        { status, admin_notes: notes || undefined },
        token,
      );
      onUpdate();
    } catch (err) {
      console.error("Failed to update application:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete application "${app.company_name || "Untitled"}"? This cannot be undone.`)) return;
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      await adminDeleteApplication(app.id, token);
      onUpdate();
    } catch (err) {
      console.error("Failed to delete application:", err);
    } finally {
      setLoading(false);
    }
  }

  const statusBadge = {
    draft: { bg: "bg-secondary", text: "text-muted-foreground", icon: FileText, label: "Draft" },
    submitted: { bg: "bg-blue-100", text: "text-blue-700", icon: Clock, label: "Submitted" },
    accepted: { bg: "bg-green-100", text: "text-green-700", icon: CheckCircle2, label: "Accepted" },
    rejected: { bg: "bg-red-100", text: "text-red-700", icon: XCircle, label: "Rejected" },
  }[app.status] || { bg: "bg-secondary", text: "text-muted-foreground", icon: FileText, label: app.status };

  const StatusIcon = statusBadge.icon;

  return (
    <div className="card-clean overflow-hidden">
      {/* Summary row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-secondary/30"
      >
        <span className="text-muted-foreground">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="truncate text-sm font-bold">
              {app.company_name || "Untitled"}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-none px-2 py-0.5 text-[10px] font-semibold ${statusBadge.bg} ${statusBadge.text}`}
            >
              <StatusIcon className="h-3 w-3" />
              {statusBadge.label}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
            <span>{app.founder_name || "—"}</span>
            <span>{app.email || "—"}</span>
            <span>{app.category || "—"}</span>
            {app.submitted_at && (
              <span>
                {new Date(app.submitted_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
          </div>
        </div>
        {app.tagline && (
          <span className="hidden max-w-xs truncate text-xs text-muted-foreground lg:block">
            {app.tagline}
          </span>
        )}
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border px-5 py-5">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Founder */}
            <div>
              <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Founder
              </h4>
              <div className="space-y-2 text-sm">
                <Field label="Name" value={app.founder_name} />
                <Field label="Bio" value={app.founder_bio} />
                <Field label="AI Experience" value={app.agent_experience} />
                <Field label="Past Projects" value={app.prev_projects} />
                <div className="flex gap-3 pt-1">
                  {app.founder_linkedin && (
                    <LinkTag href={app.founder_linkedin} label="LinkedIn" />
                  )}
                  {app.founder_github && (
                    <LinkTag href={app.founder_github} label="GitHub" />
                  )}
                  {app.founder_twitter && (
                    <LinkTag href={app.founder_twitter} label="Twitter" />
                  )}
                </div>
              </div>
            </div>

            {/* Idea + Blueprint */}
            <div>
              <h4 className="mb-3 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Idea & Blueprint
              </h4>
              <div className="space-y-2 text-sm">
                <Field label="Company" value={app.company_name} />
                <Field label="Tagline" value={app.tagline} />
                <Field label="Category" value={app.category} />
                <Field label="Problem" value={app.problem_statement} />
                <Field label="Target Customer" value={app.target_customer} />
                <Field label="Agent Core Loop" value={app.agent_core_loop} />
                <Field label="First 24 Hours" value={app.first_twenty_four_hours} />
              </div>
            </div>
          </div>

          {/* Admin notes */}
          {app.admin_notes && (
            <div className="mt-4 rounded-none bg-secondary px-4 py-3">
              <span className="text-xs font-bold text-muted-foreground">
                Admin Notes:
              </span>
              <p className="mt-1 text-sm">{app.admin_notes}</p>
            </div>
          )}

          {/* Actions */}
          <div className="mt-5 flex items-end gap-3 border-t border-border pt-5">
            {app.status === "submitted" && (
              <>
                <div className="flex-1">
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    Admin Notes (optional)
                  </label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Internal notes about this application..."
                    rows={2}
                    className="w-full rounded-none border border-border bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-accent-orange"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleAction("rejected")}
                    disabled={loading}
                    className="inline-flex items-center gap-1.5 rounded-none border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                  >
                    <XCircle className="h-3.5 w-3.5" />
                    Reject
                  </button>
                  <button
                    onClick={() => handleAction("accepted")}
                    disabled={loading}
                    className="btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-sm"
                  >
                    {loading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    )}
                    Accept & Provision
                  </button>
                </div>
              </>
            )}
            {app.status !== "submitted" && <div className="flex-1" />}
            <button
              onClick={handleDelete}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-none border border-border bg-white px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <span className="font-medium text-muted-foreground">{label}:</span>{" "}
      <span className="text-foreground">{value}</span>
    </div>
  );
}

function LinkTag({ href, label }: { href: string; label: string }) {
  const url = href.startsWith("http") ? href : `https://${href}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-none bg-secondary px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-border hover:text-foreground"
    >
      {label}
      <ExternalLink className="h-3 w-3" />
    </a>
  );
}
