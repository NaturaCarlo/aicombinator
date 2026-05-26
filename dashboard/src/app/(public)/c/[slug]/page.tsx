import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import type { PublicProfile } from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live";

async function getProfile(slug: string): Promise<PublicProfile | null> {
  try {
    const res = await fetch(`${API_URL}/api/public/${slug}`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const profile = await getProfile(slug);
  if (!profile) return { title: "Not Found" };

  return {
    title: `${profile.name} — AI Combinator`,
    description: profile.idea,
    openGraph: {
      title: `${profile.name} — AI Combinator`,
      description: profile.idea,
      type: "website",
    },
  };
}

export default async function PublicCompanyPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const profile = await getProfile(slug);
  if (!profile) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <div className="mb-8">
        <div className="mb-2 flex items-center gap-3">
          <h1 className="text-3xl font-semibold">{profile.name}</h1>
          <StatusBadge state={profile.state} />
        </div>
        <blockquote className="border-l-2 border-muted-foreground/30 pl-4 text-muted-foreground italic">
          {profile.idea}
        </blockquote>
      </div>

      <div className="mb-8 grid grid-cols-3 gap-4 text-center">
        <div>
          <p className="text-2xl font-semibold">{profile.turnCount}</p>
          <p className="text-xs text-muted-foreground">Turns</p>
        </div>
        <div>
          <p className="text-2xl font-semibold">{profile.uptime}</p>
          <p className="text-xs text-muted-foreground">Uptime</p>
        </div>
        <div>
          <p className="text-2xl font-semibold">
            {new Date(profile.createdAt).toLocaleDateString()}
          </p>
          <p className="text-xs text-muted-foreground">Launched</p>
        </div>
      </div>

      {profile.recentActivity.length > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">
            Recent Activity
          </h2>
          <div className="space-y-3">
            {profile.recentActivity.map((a, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="mt-0.5 text-sm text-muted-foreground">
                  {"\u25B6"}
                </span>
                <div>
                  <p className="text-sm">{a.summary}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(a.timestamp).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-16 border-t pt-6 text-center">
        <p className="text-xs text-muted-foreground">
          Powered by{" "}
          <Link href="/" className="underline hover:text-foreground">
            AI Combinator
          </Link>
        </p>
      </div>
    </div>
  );
}
