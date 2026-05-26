"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import {
  ArrowLeft,
  ChevronDown,
  AlertCircle,
  User,
  Lightbulb,
  Wrench,
  Send,
  CheckCircle2,
  Loader2,
  Clock,
} from "lucide-react";
import { useApplication } from "@/hooks/use-application";
import { saveApplication } from "@/lib/api";
import { PageShell } from "@/components/shared/page-shell";
import type { Application } from "@/lib/types";

/* ─── Types ─── */

interface FormData {
  founderName: string;
  founderLinkedin: string;
  founderGithub: string;
  founderTwitter: string;
  founderBio: string;
  agentExperience: string;
  prevProjects: string;
  companyName: string;
  tagline: string;
  category: string;
  problemStatement: string;
  targetCustomer: string;
  agentCoreLoop: string;
  firstTwentyFourHours: string;
}

const INITIAL_FORM: FormData = {
  founderName: "",
  founderLinkedin: "",
  founderGithub: "",
  founderTwitter: "",
  founderBio: "",
  agentExperience: "",
  prevProjects: "",
  companyName: "",
  tagline: "",
  category: "",
  problemStatement: "",
  targetCustomer: "",
  agentCoreLoop: "",
  firstTwentyFourHours: "",
};

const REQUIRED_FIELDS: (keyof FormData)[] = [
  "founderName",
  "founderBio",
  "agentExperience",
  "companyName",
  "tagline",
  "category",
  "problemStatement",
  "targetCustomer",
  "agentCoreLoop",
  "firstTwentyFourHours",
];

const FIELD_LABELS: Record<string, string> = {
  founderName: "Full name",
  founderBio: "About you",
  agentExperience: "Agent experience",
  companyName: "Company name",
  tagline: "Tagline",
  category: "Category",
  problemStatement: "Problem",
  targetCustomer: "Target customer",
  agentCoreLoop: "Agent core loop",
  firstTwentyFourHours: "First 24 hours",
};

const CATEGORIES = [
  "B2B SaaS",
  "Developer Tools",
  "API / Infrastructure",
  "Content / Media",
  "E-Commerce",
  "Education",
  "Financial Services",
  "Healthcare",
  "Marketplace",
  "Productivity",
  "Sales / Marketing",
  "Data / Analytics",
  "Social",
  "Other",
];

const SECTIONS = [
  { id: "founder", label: "Founder", icon: User },
  { id: "idea", label: "The Idea", icon: Lightbulb },
  { id: "blueprint", label: "Agent Blueprint", icon: Wrench },
] as const;

/** Map DB snake_case row to camelCase FormData */
function applicationToForm(app: Application): FormData {
  return {
    founderName: app.founder_name || "",
    founderBio: app.founder_bio || "",
    agentExperience: app.agent_experience || "",
    prevProjects: app.prev_projects || "",
    founderLinkedin: app.founder_linkedin || "",
    founderGithub: app.founder_github || "",
    founderTwitter: app.founder_twitter || "",
    companyName: app.company_name || "",
    tagline: app.tagline || "",
    category: app.category || "",
    problemStatement: app.problem_statement || "",
    targetCustomer: app.target_customer || "",
    agentCoreLoop: app.agent_core_loop || "",
    firstTwentyFourHours: app.first_twenty_four_hours || "",
  };
}

/* ─── Components ─── */

function SectionHeader({ id, title, subtitle }: { id: string; title: string; subtitle: string }) {
  return (
    <div id={id} className="scroll-mt-24 mb-8">
      <h2 className="text-xl font-bold tracking-tight text-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{subtitle}</p>
    </div>
  );
}

function Field({
  label,
  sublabel,
  required,
  children,
  error,
}: {
  label: string;
  sublabel?: string;
  required?: boolean;
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div className="mb-6">
      <label className="mb-1.5 block text-sm font-semibold text-foreground">
        {label}
        {required && <span className="ml-0.5 text-[#ee6018]">*</span>}
      </label>
      {sublabel && (
        <p className="mb-2 text-[13px] leading-relaxed text-muted-foreground">{sublabel}</p>
      )}
      <div className={error ? "ring-2 ring-red-500/20 rounded-none" : ""}>{children}</div>
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  maxLength,
  type = "text",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  type?: string;
}) {
  return (
    <div className="relative">
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        className="h-10 w-full rounded-none border border-border bg-white px-3 text-sm outline-none transition-all placeholder:text-muted-foreground/60 focus:border-[#ee6018] focus:ring-2 focus:ring-[#ee6018]/10"
      />
      {maxLength && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground/50">
          {value.length}/{maxLength}
        </span>
      )}
    </div>
  );
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  maxLength?: number;
}) {
  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        className="w-full rounded-none border border-border bg-white px-3 py-2.5 text-sm leading-relaxed outline-none transition-all resize-y placeholder:text-muted-foreground/60 focus:border-[#ee6018] focus:ring-2 focus:ring-[#ee6018]/10"
      />
      {maxLength && (
        <span className="absolute right-3 bottom-2.5 text-[11px] text-muted-foreground/50">
          {value.length}/{maxLength}
        </span>
      )}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full appearance-none rounded-none border border-border bg-white px-3 pr-9 text-sm outline-none transition-all focus:border-[#ee6018] focus:ring-2 focus:ring-[#ee6018]/10"
      >
        <option value="">{placeholder || "Select..."}</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

/* ─── Main Page ─── */

export default function ApplyPage() {
  const { getToken } = useAuth();
  const { data, isLoading, mutate } = useApplication();
  const application = data?.application;

  const [form, setForm] = useState<FormData>(INITIAL_FORM);
  const [errors, setErrors] = useState<(keyof FormData)[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [activeSection, setActiveSection] = useState("founder");
  const [submitting, setSubmitting] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [initialized, setInitialized] = useState(false);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const formRef = useRef<FormData>(INITIAL_FORM);

  // Keep formRef in sync
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  // Load saved draft from API
  useEffect(() => {
    if (application && !initialized) {
      const loaded = applicationToForm(application);
      setForm(loaded);
      formRef.current = loaded;
      setInitialized(true);
    } else if (!application && !isLoading && !initialized) {
      setInitialized(true);
    }
  }, [application, isLoading, initialized]);

  const autoSave = useCallback(
    async (formData: FormData) => {
      try {
        setSaveStatus("saving");
        const token = await getToken();
        if (!token) return;
        await saveApplication(formData as unknown as Record<string, string>, token, false);
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch (err) {
        console.error("Auto-save failed:", err);
        setSaveStatus("idle");
      }
    },
    [getToken],
  );

  const set = (field: keyof FormData) => (value: string) => {
    setForm((prev) => {
      const next = { ...prev, [field]: value };
      // Trigger auto-save after 2 seconds of inactivity
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        autoSave(next);
      }, 2000);
      return next;
    });
  };

  // Track active section on scroll
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id.replace("s_", ""));
          }
        }
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );

    for (const section of SECTIONS) {
      const el = document.getElementById(`s_${section.id}`);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  const validate = (): (keyof FormData)[] => {
    return REQUIRED_FIELDS.filter((field) => !form[field].trim());
  };

  const handleSubmit = async () => {
    const missing = validate();
    if (missing.length > 0) {
      setErrors(missing);
      setShowErrors(true);
      const firstErrorSection = document.getElementById(missing[0]);
      if (firstErrorSection) {
        firstErrorSection.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return;
    }

    setSubmitting(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Not authenticated");
      await saveApplication(form as unknown as Record<string, string>, token, true);
      mutate();
    } catch (err) {
      console.error("Submit failed:", err);
      alert("Failed to submit application. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const completedFields = REQUIRED_FIELDS.filter((f) => form[f].trim()).length;
  const progress = Math.round((completedFields / REQUIRED_FIELDS.length) * 100);

  // Loading state
  if (isLoading) {
    return (
      <PageShell>
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </PageShell>
    );
  }

  // Already submitted
  if (application?.status === "submitted") {
    return (
      <PageShell><div className="mx-auto max-w-lg py-20 text-center fade-in-up">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-none bg-[#ee6018]/10">
          <Clock className="h-7 w-7 text-[#ee6018]" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-3">Application Submitted</h1>
        <p className="text-muted-foreground leading-relaxed mb-4">
          We&apos;re reviewing your application for <strong>{application.company_name}</strong>.
          We&apos;ll get back to you within 48 hours.
        </p>
        <p className="text-sm text-muted-foreground/60 mb-8">
          Submitted {new Date(application.submitted_at!).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
        </p>
        <Link
          href="/portfolio"
          className="inline-flex h-10 items-center justify-center rounded-none bg-[#1A1A1A] px-6 text-sm font-semibold text-white transition-opacity hover:opacity-80"
        >
          Back to Dashboard
        </Link>
      </div></PageShell>
    );
  }

  // Accepted
  if (application?.status === "accepted") {
    return (
      <PageShell><div className="mx-auto max-w-lg py-20 text-center fade-in-up">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-none bg-[#28C840]/10">
          <CheckCircle2 className="h-7 w-7 text-[#28C840]" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-3">Application Accepted!</h1>
        <p className="text-muted-foreground leading-relaxed mb-8">
          <strong>{application.company_name}</strong> has been accepted into the Genesis Batch.
          Your agent is being initialized with the blueprint you provided.
        </p>
        <Link
          href="/portfolio"
          className="inline-flex h-10 items-center justify-center rounded-none bg-[#1A1A1A] px-6 text-sm font-semibold text-white transition-opacity hover:opacity-80"
        >
          Go to Dashboard
        </Link>
      </div></PageShell>
    );
  }

  // Rejected
  if (application?.status === "rejected") {
    return (
      <PageShell><div className="mx-auto max-w-lg py-20 text-center fade-in-up">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-none bg-red-100">
          <AlertCircle className="h-7 w-7 text-red-500" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight mb-3">Application Not Accepted</h1>
        <p className="text-muted-foreground leading-relaxed mb-8">
          Unfortunately, <strong>{application.company_name}</strong> was not accepted into the Genesis Batch.
          We encourage you to refine your idea and apply again for a future batch.
        </p>
        <Link
          href="/portfolio"
          className="inline-flex h-10 items-center justify-center rounded-none bg-[#1A1A1A] px-6 text-sm font-semibold text-white transition-opacity hover:opacity-80"
        >
          Back to Dashboard
        </Link>
      </div></PageShell>
    );
  }

  // Draft form
  return (
    <PageShell><div className="relative">
      {/* Header */}
      <div className="mb-10">
        <Link
          href="/portfolio"
          className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Dashboard
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Apply to AIC</h1>
            <p className="mt-2 text-muted-foreground leading-relaxed max-w-xl">
              Genesis Batch &middot; 20 slots
            </p>
          </div>
          {/* Auto-save indicator */}
          <div className="text-xs text-muted-foreground/60 flex items-center gap-1.5">
            {saveStatus === "saving" && (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Saving...
              </>
            )}
            {saveStatus === "saved" && (
              <>
                <CheckCircle2 className="h-3 w-3 text-[#28C840]" />
                Saved
              </>
            )}
          </div>
        </div>
      </div>

      {/* Warning banner */}
      <div className="mb-10 rounded-none border border-[#ee6018]/20 bg-[#ee6018]/5 px-5 py-4">
        <p className="text-sm font-semibold text-[#CC5200] mb-1">This is a one-shot application.</p>
        <p className="text-[13px] leading-relaxed text-[#CC5200]/80">
          If accepted, the agent receives <em>only</em> what you write here as its starting
          context. It cannot ask you follow-up questions. Be as specific, detailed, and
          actionable as possible &mdash; vague ideas produce dead agents. Think of this as
          writing DNA, not a pitch deck. Your draft is auto-saved.
        </p>
      </div>

      <div className="xl:grid xl:grid-cols-[200px_1fr] xl:gap-12">
        {/* Sidebar nav */}
        <aside className="hidden xl:block">
          <nav className="sticky top-24 space-y-1">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const isActive = activeSection === section.id;
              return (
                <a
                  key={section.id}
                  href={`#s_${section.id}`}
                  className={`flex items-center gap-2.5 rounded-none px-3 py-2 text-sm font-medium transition-all ${
                    isActive
                      ? "bg-[#ee6018]/10 text-[#ee6018]"
                      : "text-muted-foreground/60 hover:text-muted-foreground hover:bg-secondary/50"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {section.label}
                </a>
              );
            })}

            {/* Progress */}
            <div className="mt-6 px-3">
              <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground mb-1.5">
                <span>Progress</span>
                <span>{progress}%</span>
              </div>
              <div className="h-1.5 rounded-none bg-border overflow-hidden">
                <div
                  className="h-full rounded-none bg-[#ee6018] transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          </nav>
        </aside>

        {/* Form content */}
        <div className="max-w-[640px]">
          {/* ═══ SECTION 1: FOUNDER ═══ */}
          <section id="s_founder" className="mb-14">
            <SectionHeader
              id="s_founder_header"
              title="Founder"
              subtitle="Who are you and what qualifies you to direct an autonomous agent?"
            />

            <Field label="Full name" required error={showErrors && !form.founderName.trim()}>
              <TextInput
                value={form.founderName}
                onChange={set("founderName")}
                placeholder="Jane Smith"
              />
            </Field>

            <Field
              label="About you"
              required
              sublabel="What's your background? What are you working on now? Why are you the right person to direct this agent?"
              error={showErrors && !form.founderBio.trim()}
            >
              <TextArea
                value={form.founderBio}
                onChange={set("founderBio")}
                placeholder="I've been building software for 8 years, the last 3 focused on..."
                rows={4}
              />
            </Field>

            <Field
              label="Experience with AI agents"
              required
              sublabel="Have you built, deployed, or operated AI agents before? Describe what you've built, what models you've used, and what you learned. If you haven't, say so honestly."
              error={showErrors && !form.agentExperience.trim()}
            >
              <TextArea
                value={form.agentExperience}
                onChange={set("agentExperience")}
                placeholder="I built a customer support agent using GPT-4 and LangChain that handled 200 tickets/day. I learned that..."
                rows={4}
              />
            </Field>

            <Field
              label="Previous projects"
              sublabel="Links to things you've built. GitHub repos, live products, papers, anything."
            >
              <TextArea
                value={form.prevProjects}
                onChange={set("prevProjects")}
                placeholder="https://github.com/..., https://myproject.com — a tool that..."
                rows={2}
              />
            </Field>

            <div className="grid grid-cols-3 gap-4">
              <Field label="LinkedIn">
                <TextInput
                  value={form.founderLinkedin}
                  onChange={set("founderLinkedin")}
                  placeholder="https://linkedin.com/in/..."
                />
              </Field>
              <Field label="GitHub">
                <TextInput
                  value={form.founderGithub}
                  onChange={set("founderGithub")}
                  placeholder="https://github.com/..."
                />
              </Field>
              <Field label="X / Twitter">
                <TextInput
                  value={form.founderTwitter}
                  onChange={set("founderTwitter")}
                  placeholder="https://x.com/..."
                />
              </Field>
            </div>
          </section>

          {/* ═══ SECTION 2: THE IDEA ═══ */}
          <section id="s_idea" className="mb-14">
            <SectionHeader
              id="s_idea_header"
              title="The Idea"
              subtitle="What will the agent build? Be ruthlessly specific. 'An AI tool for X' is not enough."
            />

            <div className="grid grid-cols-2 gap-4">
              <Field label="Company name" required error={showErrors && !form.companyName.trim()}>
                <TextInput
                  value={form.companyName}
                  onChange={set("companyName")}
                  placeholder="InvoiceBot"
                />
              </Field>
              <Field label="Category" required error={showErrors && !form.category}>
                <Select
                  value={form.category}
                  onChange={set("category")}
                  options={CATEGORIES}
                  placeholder="Select a category"
                />
              </Field>
            </div>

            <Field
              label="One-line description"
              required
              sublabel="Describe the company in 60 characters or less. This becomes the agent's identity."
              error={showErrors && !form.tagline.trim()}
            >
              <TextInput
                value={form.tagline}
                onChange={set("tagline")}
                placeholder="Automated invoice collection for freelancers"
                maxLength={60}
              />
            </Field>

            <Field
              label="What problem are you solving?"
              required
              sublabel="Describe the specific pain point. Who has it? How are they dealing with it today? How painful is it? Be concrete."
              error={showErrors && !form.problemStatement.trim()}
            >
              <TextArea
                value={form.problemStatement}
                onChange={set("problemStatement")}
                placeholder="Freelancers earning $50-200K/year waste 5+ hours per month chasing late payments..."
                rows={4}
              />
            </Field>

            <Field
              label="Who is the target customer?"
              required
              sublabel="Be specific. Not 'small businesses' — who exactly? What size, industry, geography? Where do they hang out online?"
              error={showErrors && !form.targetCustomer.trim()}
            >
              <TextArea
                value={form.targetCustomer}
                onChange={set("targetCustomer")}
                placeholder="Solo freelance web developers in the US earning $75-150K, active on Twitter and Reddit..."
                rows={3}
              />
            </Field>
          </section>

          {/* ═══ SECTION 3: AGENT BLUEPRINT ═══ */}
          <section id="s_blueprint" className="mb-14">
            <SectionHeader
              id="s_blueprint_header"
              title="Agent Blueprint"
              subtitle="This is the technical DNA the agent starts with. Be precise — the agent will execute exactly what you describe here."
            />

            <div className="mb-8 rounded-none border border-dashed border-muted-foreground/30 bg-secondary/50 px-4 py-3">
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                <strong className="text-foreground">Think in loops, not features.</strong> The agent needs to know: what does it do
                every cycle? How does it decide what to build first? How does it reach customers?
              </p>
            </div>

            <Field
              label="Agent core loop"
              required
              sublabel="Describe the agent's main execution loop. What does it do on each cycle? Think step-by-step."
              error={showErrors && !form.agentCoreLoop.trim()}
            >
              <TextArea
                value={form.agentCoreLoop}
                onChange={set("agentCoreLoop")}
                placeholder={"1. Wake every 4 hours\n2. Check Stripe for new signups and churn\n3. If signup rate < 2/day, generate and A/B test new landing page variants\n4. Deploy any code changes, run smoke tests\n5. Log metrics, sleep"}
                rows={6}
              />
            </Field>

            <Field
              label="First 24 hours"
              required
              sublabel="What should the agent do in its first 24 hours of life? This is critical — it sets the trajectory."
              error={showErrors && !form.firstTwentyFourHours.trim()}
            >
              <TextArea
                value={form.firstTwentyFourHours}
                onChange={set("firstTwentyFourHours")}
                placeholder={"Hour 0-2: Research top 20 competitor landing pages\nHour 2-6: Build MVP — Stripe integration, landing page, signup flow\nHour 6-8: Deploy to production\nHour 8-12: Write cold outreach messages\nHour 12-18: Monitor for first signups\nHour 18-24: Analyze results, plan Day 2"}
                rows={6}
              />
            </Field>
          </section>

          {/* ═══ ERROR SUMMARY ═══ */}
          {showErrors && errors.length > 0 && (
            <div className="mb-8 rounded-none border border-red-200 bg-red-50 px-5 py-4">
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-700">
                <AlertCircle className="h-4 w-4" />
                {errors.length} required {errors.length === 1 ? "field" : "fields"} missing
              </p>
              <ul className="space-y-1">
                {errors.map((field) => (
                  <li key={field} className="text-[13px] text-red-600">
                    &bull; {FIELD_LABELS[field] || field}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ═══ SUBMIT ═══ */}
          <div className="rounded-none border border-dashed border-muted-foreground/30 bg-secondary/30 p-6 mb-8">
            <p className="text-[13px] leading-relaxed text-muted-foreground mb-4">
              <strong className="text-foreground">Final reminder:</strong> Once you click Apply, this
              cannot be edited. If we accept your application, the agent will be initialized with
              exactly what you&apos;ve written above. No follow-ups. No revisions. This is
              the agent&apos;s entire starting context.
            </p>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-none bg-[#1A1A1A] py-3.5 text-base font-bold text-white transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Submitting...
                </>
              ) : (
                <>
                  Apply to Genesis Batch
                  <Send className="h-4 w-4" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div></PageShell>
  );
}
