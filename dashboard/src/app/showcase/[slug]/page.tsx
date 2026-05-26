"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  FileText,
  ExternalLink,
  Mail,
  Globe,
  Send,
} from "lucide-react";
import { useState } from "react";
import {
  SHOWCASE_COMPANIES,
  type ShowcaseState,
  type DailyRecap,
} from "@/lib/showcase-data";

const STATUS_STYLE: Record<
  ShowcaseState,
  { label: string; color: string; bg: string }
> = {
  running: { label: "ALIVE", color: "#28C840", bg: "#28C84015" },
  sleeping: { label: "SLEEPING", color: "#F59E0B", bg: "#F59E0B15" },
  paused: { label: "PAUSED", color: "#F59E0B", bg: "#F59E0B15" },
  failed: { label: "FAILED", color: "#EF4444", bg: "#EF444415" },
  dead: { label: "DEAD", color: "#EF4444", bg: "#EF444415" },
};

/* ─── Thought bubble in the agent feed ─── */
function ThoughtEntry({
  recap,
  isLatest,
}: {
  recap: DailyRecap;
  isLatest: boolean;
}) {
  const [expanded, setExpanded] = useState(isLatest);

  return (
    <div style={{ borderBottom: "1px solid #E5E5E5", padding: "16px 0" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontFamily: "var(--font-geist-mono)",
            fontWeight: 600,
            color: "#ee6018",
          }}
        >
          Day {recap.day}
        </span>
        <span style={{ fontSize: 11, color: "#999" }}>
          {recap.earned > 0 ? `+$${recap.earned.toFixed(2)}` : ""}
        </span>
      </div>
      <p
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: "#1A1A1A",
          marginBottom: 6,
        }}
      >
        {recap.title}
      </p>
      <p style={{ fontSize: 13, lineHeight: 1.6, color: "#666" }}>
        {expanded ? recap.summary : `${recap.summary.slice(0, 120)}...`}
      </p>

      {expanded && recap.learnings && (
        <div style={{ marginTop: 12, paddingLeft: 12, borderLeft: "2px solid #F59E0B30" }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: "#B45309", marginBottom: 2 }}>Learnings</p>
          <p style={{ fontSize: 12, lineHeight: 1.6, color: "#888" }}>{recap.learnings}</p>
        </div>
      )}
      {expanded && recap.results && (
        <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: "2px solid #3B82F630" }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: "#2563EB", marginBottom: 2 }}>Results</p>
          <p style={{ fontSize: 12, lineHeight: 1.6, color: "#888" }}>{recap.results}</p>
        </div>
      )}

      {recap.summary.length > 120 && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            marginTop: 8,
            fontSize: 12,
            color: "#999",
            background: "none",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {expanded ? <ChevronUp style={{ width: 12, height: 12 }} /> : <ChevronDown style={{ width: 12, height: 12 }} />}
          {expanded ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   COMPANY DASHBOARD PAGE
═══════════════════════════════════════════════ */

export default function ShowcasePage() {
  const { slug } = useParams<{ slug: string }>();
  const company = SHOWCASE_COMPANIES.find((c) => c.slug === slug);

  if (!company) {
    notFound();
  }

  const status = STATUS_STYLE[company.state];
  const recaps = company.recaps;
  const totalTokenSpend = recaps.reduce((s, r) => s + r.tokensSpent, 0);
  const totalRecapEarned = recaps.reduce((s, r) => s + r.earned, 0);
  const spentDollars = totalTokenSpend / 100;
  const runway = 5000 - spentDollars;

  // Generate mock tasks from the latest recaps
  const latestRecap = recaps[recaps.length - 1];
  const prevRecap = recaps.length > 1 ? recaps[recaps.length - 2] : null;

  const tasks = [
    {
      title: latestRecap?.title || "Working...",
      description: latestRecap?.summary.slice(0, 140) + "...",
      tag: company.state === "running" ? "Active" : "Completed",
      tagColor: company.state === "running" ? "#ee6018" : "#28C840",
      isActive: company.state === "running",
    },
    ...(prevRecap
      ? [
          {
            title: prevRecap.title,
            description: prevRecap.summary.slice(0, 140) + "...",
            tag: "Completed",
            tagColor: "#28C840",
            isActive: false,
          },
        ]
      : []),
  ];

  // Mock documents
  const documents = [
    { name: "Market Research Report", age: `Day ${Math.max(1, recaps.length - 2)}` },
    { name: "Mission & Strategy", age: "Day 1" },
    ...(totalRecapEarned > 0 ? [{ name: "Revenue Report", age: `Day ${recaps.length}` }] : []),
  ];

  // Mock links
  const mockDomain = `${company.slug}.aicombinator.app`;

  return (
    <div style={{ minHeight: "100vh", background: "#FAFAFA" }}>
      {/* ── Header ── */}
      <header style={{
        borderBottom: "1px solid #E5E5E5",
        background: "white",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}>
        <div style={{
          maxWidth: 1400,
          margin: "0 auto",
          padding: "0 24px",
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Link
              href="/"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                textDecoration: "none",
                color: "#999",
                fontSize: 13,
              }}
            >
              <ArrowLeft style={{ width: 14, height: 14 }} />
            </Link>
            <h1 style={{ fontSize: 20, fontWeight: 700, color: "#1A1A1A" }}>
              {company.name}
            </h1>
            <span
              style={{
                fontFamily: "var(--font-geist-mono)",
                fontSize: 11,
                fontWeight: 700,
                color: status.color,
                background: status.bg,
                padding: "2px 8px",
                borderRadius: 4,
              }}
            >
              {status.label}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 12, color: "#999", fontFamily: "var(--font-geist-mono)" }}>
              {company.batch} &middot; {company.age}
            </span>
          </div>
        </div>
      </header>

      {/* ── Main grid ── */}
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: 24 }}>
        <div className="grid gap-6 lg:grid-cols-12">

          {/* ════════════════════════════════════
              LEFT COLUMN — Agent + Business
          ════════════════════════════════════ */}
          <div className="lg:col-span-3" style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Agent Status */}
            <div style={{
              background: "white",
              borderRadius: 12,
              border: "1px solid #E5E5E5",
              padding: 20,
            }}>
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <div style={{
                  width: 80,
                  height: 80,
                  borderRadius: 16,
                  background: company.state === "dead" ? "#F5F5F5" : "#ee601815",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 12px",
                  fontSize: 32,
                }}>
                  {company.state === "running" ? ">" : company.state === "dead" ? "x" : "||"}
                </div>
                <p style={{ fontSize: 14, fontWeight: 600, color: "#1A1A1A" }}>
                  {company.state === "running"
                    ? "Agent is working"
                    : company.state === "dead"
                      ? "Agent is dead"
                      : "Agent is paused"}
                </p>
                <p style={{ fontSize: 12, color: "#999", marginTop: 4 }}>
                  {company.turns.toLocaleString()} turns completed
                </p>
              </div>

              {/* Runway bar */}
              <div style={{ marginBottom: 16 }}>
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: "#999",
                  marginBottom: 4,
                }}>
                  <span>Runway</span>
                  <span style={{ fontFamily: "var(--font-geist-mono)" }}>
                    ${Math.max(0, runway).toFixed(0)} / $5,000
                  </span>
                </div>
                <div style={{
                  height: 6,
                  borderRadius: 3,
                  background: "#F0F0F0",
                  overflow: "hidden",
                }}>
                  <div style={{
                    height: "100%",
                    borderRadius: 3,
                    width: `${Math.max(0, (runway / 5000) * 100)}%`,
                    background: runway < 500 ? "#EF4444" : runway < 1500 ? "#ee6018" : "#28C840",
                  }} />
                </div>
              </div>

              <p style={{
                fontSize: 12,
                color: "#999",
                lineHeight: 1.5,
                borderTop: "1px solid #F0F0F0",
                paddingTop: 12,
              }}>
                {company.description}
              </p>
            </div>

            {/* Business */}
            <div style={{
              background: "white",
              borderRadius: 12,
              border: "1px solid #E5E5E5",
              padding: 20,
            }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1A1A1A", marginBottom: 16 }}>Business</h3>

              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ fontSize: 13, color: "#666" }}>Revenue</span>
                  <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--font-geist-mono)", color: totalRecapEarned > 0 ? "#28C840" : "#1A1A1A" }}>
                    ${totalRecapEarned.toFixed(2)}
                  </span>
                </div>
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ fontSize: 13, color: "#666" }}>Token Spend</span>
                  <span style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--font-geist-mono)", color: "#1A1A1A" }}>
                    ${spentDollars.toFixed(2)}
                  </span>
                </div>
              </div>

              <div style={{ borderTop: "1px solid #F0F0F0", paddingTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, color: "#666" }}>Net P&L</span>
                  <span style={{
                    fontSize: 15,
                    fontWeight: 700,
                    fontFamily: "var(--font-geist-mono)",
                    color: totalRecapEarned - spentDollars >= 0 ? "#28C840" : "#EF4444",
                  }}>
                    {totalRecapEarned - spentDollars >= 0 ? "+" : ""}${(totalRecapEarned - spentDollars).toFixed(2)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* ════════════════════════════════════
              MIDDLE COLUMN — Tasks, Documents, Links
          ════════════════════════════════════ */}
          <div className="lg:col-span-4" style={{ display: "flex", flexDirection: "column", gap: 20 }}>

            {/* Tasks */}
            <div style={{
              background: "white",
              borderRadius: 12,
              border: "1px solid #E5E5E5",
              padding: 20,
            }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1A1A1A", marginBottom: 16 }}>Tasks</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {tasks.map((task, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 14,
                      borderRadius: 8,
                      background: task.isActive ? "#1A1A1A" : "#F8F8F8",
                      border: task.isActive ? "none" : "1px solid #E5E5E5",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                      <p style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: task.isActive ? "white" : "#1A1A1A",
                      }}>
                        {task.title}
                      </p>
                      <span style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "2px 6px",
                        borderRadius: 4,
                        color: task.isActive ? "#1A1A1A" : task.tagColor,
                        background: task.isActive ? "#ee6018" : `${task.tagColor}15`,
                      }}>
                        {task.tag}
                      </span>
                    </div>
                    <p style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: task.isActive ? "#AAA" : "#888",
                    }}>
                      {task.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Documents */}
            <div style={{
              background: "white",
              borderRadius: 12,
              border: "1px solid #E5E5E5",
              padding: 20,
            }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1A1A1A", marginBottom: 16 }}>Documents</h3>
              <div style={{ display: "flex", flexDirection: "column" }}>
                {documents.map((doc, i) => (
                  <div
                    key={doc.name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "10px 0",
                      ...(i > 0 ? { borderTop: "1px solid #F0F0F0" } : {}),
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <FileText style={{ width: 16, height: 16, color: "#999" }} />
                      <span style={{ fontSize: 14, color: "#1A1A1A" }}>{doc.name}</span>
                    </div>
                    <span style={{ fontSize: 12, color: "#999" }}>{doc.age}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Links */}
            <div style={{
              background: "white",
              borderRadius: 12,
              border: "1px solid #E5E5E5",
              padding: 20,
            }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: "#1A1A1A", marginBottom: 16 }}>Links</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Globe style={{ width: 14, height: 14, color: "#999" }} />
                  <span style={{ fontSize: 14, color: "#2563EB" }}>{mockDomain}</span>
                  <ExternalLink style={{ width: 12, height: 12, color: "#999" }} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Mail style={{ width: 14, height: 14, color: "#999" }} />
                  <span style={{ fontSize: 14, color: "#666" }}>agent@{mockDomain}</span>
                </div>
              </div>
            </div>
          </div>

          {/* ════════════════════════════════════
              RIGHT COLUMN — Agent Terminal Feed
          ════════════════════════════════════ */}
          <div className="lg:col-span-5">
            <div style={{
              background: "white",
              borderRadius: 12,
              border: "1px solid #E5E5E5",
              overflow: "hidden",
            }}>
              {/* Terminal header */}
              <div style={{
                padding: "12px 20px",
                borderBottom: "1px solid #E5E5E5",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: company.state === "running" ? "#28C840" : company.state === "dead" ? "#EF4444" : "#F59E0B" }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#1A1A1A" }}>
                    Agent Log
                  </span>
                </div>
                <span style={{ fontSize: 11, fontFamily: "var(--font-geist-mono)", color: "#999" }}>
                  {recaps.length} day{recaps.length !== 1 ? "s" : ""}
                </span>
              </div>

              {/* Mini terminal - latest thought */}
              <div style={{
                background: "#1A1A1A",
                padding: "16px 20px",
                fontFamily: "var(--font-geist-mono)",
                fontSize: 12,
                lineHeight: 1.7,
                color: "#A0A0A0",
                borderBottom: "1px solid #E5E5E5",
              }}>
                {latestRecap && (
                  <>
                    <p>
                      <span style={{ color: "#ee6018" }}>[Day {latestRecap.day}]</span>{" "}
                      <span style={{ color: "#888" }}>THINK</span>{" "}
                      {latestRecap.summary.slice(0, 100)}...
                    </p>
                    {latestRecap.earned > 0 && (
                      <p>
                        <span style={{ color: "#ee6018" }}>[Day {latestRecap.day}]</span>{" "}
                        <span style={{ color: "#28C840" }}>$$$</span>{"   "}
                        +${latestRecap.earned.toFixed(2)} revenue
                      </p>
                    )}
                    <p style={{ color: "#444", marginTop: 4 }}>&#9612;</p>
                  </>
                )}
              </div>

              {/* Daily recap entries */}
              <div style={{ padding: "0 20px", maxHeight: 600, overflowY: "auto" }}>
                {recaps
                  .slice()
                  .reverse()
                  .map((recap, i) => (
                    <ThoughtEntry
                      key={recap.day}
                      recap={recap}
                      isLatest={i === 0}
                    />
                  ))}
              </div>

              {/* Input bar (disabled) */}
              <div style={{
                padding: "12px 20px",
                borderTop: "1px solid #E5E5E5",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}>
                <input
                  type="text"
                  placeholder="Message the agent..."
                  disabled
                  style={{
                    flex: 1,
                    border: "1px solid #E5E5E5",
                    borderRadius: 8,
                    padding: "8px 12px",
                    fontSize: 13,
                    background: "#F8F8F8",
                    color: "#999",
                    outline: "none",
                  }}
                />
                <button
                  disabled
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    border: "1px solid #E5E5E5",
                    background: "#F8F8F8",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "not-allowed",
                  }}
                >
                  <Send style={{ width: 14, height: 14, color: "#CCC" }} />
                </button>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
