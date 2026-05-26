"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  ShoppingCart,
  CheckCircle2,
  XCircle,
  Clock,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useAdminPurchases } from "@/hooks/use-admin";
import { adminUpdatePurchase } from "@/lib/api";
import type { AdminPurchaseRequest } from "@/lib/types";

const STATUS_TABS = [
  { value: "pending", label: "Pending" },
  { value: undefined, label: "All" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
] as const;

export default function AdminPurchasesPage() {
  const [statusFilter, setStatusFilter] = useState<string | undefined>("pending");
  const { data, isLoading, mutate } = useAdminPurchases(statusFilter);

  const requests = data?.requests || [];

  return (
    <div className="fade-in-up">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Purchase Requests</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Review and approve agent purchase escalations
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
      ) : requests.length === 0 ? (
        <div className="card-clean flex flex-col items-center justify-center py-20">
          <ShoppingCart className="mb-3 h-8 w-8 text-muted-foreground/40" />
          <p className="text-sm font-medium text-muted-foreground">
            No purchase requests found
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => (
            <PurchaseRow
              key={req.id}
              request={req}
              onUpdate={() => mutate()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PurchaseRow({
  request,
  onUpdate,
}: {
  request: AdminPurchaseRequest;
  onUpdate: () => void;
}) {
  const { getToken } = useAuth();
  const [notes, setNotes] = useState("");
  const [showNotes, setShowNotes] = useState(false);
  const [loading, setLoading] = useState(false);

  const statusConfig = {
    pending: {
      bg: "bg-amber-100",
      text: "text-amber-700",
      icon: Clock,
      label: "Pending",
    },
    approved: {
      bg: "bg-green-100",
      text: "text-green-700",
      icon: CheckCircle2,
      label: "Approved",
    },
    rejected: {
      bg: "bg-red-100",
      text: "text-red-700",
      icon: XCircle,
      label: "Rejected",
    },
  }[request.status] || {
    bg: "bg-secondary",
    text: "text-muted-foreground",
    icon: Clock,
    label: request.status,
  };

  const StatusIcon = statusConfig.icon;

  async function handleAction(status: "approved" | "rejected") {
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      await adminUpdatePurchase(
        request.id,
        { status, admin_notes: notes || undefined },
        token,
      );
      onUpdate();
    } catch (err) {
      console.error("Failed to update purchase:", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card-clean px-5 py-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <span className="text-sm font-bold">
              {request.company_name || "Unknown Agent"}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-none px-2 py-0.5 text-[10px] font-semibold ${statusConfig.bg} ${statusConfig.text}`}
            >
              <StatusIcon className="h-3 w-3" />
              {statusConfig.label}
            </span>
            {request.amount_cents && (
              <span className="text-sm font-bold text-foreground">
                ${(request.amount_cents / 100).toFixed(2)}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {request.description}
          </p>
          <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
            {request.url && (
              <a
                href={request.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent-orange hover:underline"
              >
                View URL
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
            <span>
              {new Date(request.created_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            {request.resolved_at && (
              <span>
                Resolved{" "}
                {new Date(request.resolved_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
          </div>

          {/* Agent notes */}
          {request.notes && (
            <div className="mt-2 rounded-none bg-blue-50 px-3 py-2 text-xs text-blue-700">
              <span className="font-medium">Agent notes:</span> {request.notes}
            </div>
          )}

          {/* Admin notes */}
          {request.admin_notes && (
            <div className="mt-2 rounded-none bg-secondary px-3 py-2 text-xs">
              <span className="font-medium text-muted-foreground">Admin notes:</span>{" "}
              {request.admin_notes}
            </div>
          )}
        </div>

        {/* Actions — only for pending */}
        {request.status === "pending" && (
          <div className="flex shrink-0 flex-col gap-2">
            <div className="flex gap-2">
              <button
                onClick={() => handleAction("rejected")}
                disabled={loading}
                className="inline-flex items-center gap-1 rounded-none border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
              >
                <XCircle className="h-3 w-3" />
                Reject
              </button>
              <button
                onClick={() => handleAction("approved")}
                disabled={loading}
                className="btn-primary inline-flex items-center gap-1 px-3 py-1.5 text-xs"
              >
                {loading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3 w-3" />
                )}
                Approve
              </button>
            </div>
            <button
              onClick={() => setShowNotes(!showNotes)}
              className="text-[10px] text-muted-foreground hover:text-foreground"
            >
              {showNotes ? "Hide notes" : "+ Add notes"}
            </button>
            {showNotes && (
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Admin notes..."
                rows={2}
                className="w-48 rounded-none border border-border bg-white px-2.5 py-1.5 text-xs outline-none focus:border-accent-orange"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
