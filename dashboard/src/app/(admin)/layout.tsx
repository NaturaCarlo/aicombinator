"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { UserButton, useAuth } from "@clerk/nextjs";
import {
  LayoutDashboard,
  FileText,
  Bot,
  ShoppingCart,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { createAuthFetcher } from "@/lib/api";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { getToken, isLoaded } = useAuth();
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!isLoaded) return;

    async function checkAccess() {
      try {
        const token = await getToken();
        const fetcher = createAuthFetcher(token);
        await fetcher("/api/admin/health");
        setVerified(true);
      } catch {
        router.replace("/portfolio");
      } finally {
        setChecking(false);
      }
    }

    checkAccess();
  }, [isLoaded, getToken, router]);

  if (checking || !verified) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Verifying access...</p>
        </div>
      </div>
    );
  }

  const navItems = [
    { href: "/admin", label: "Overview", icon: LayoutDashboard },
    { href: "/admin/applications", label: "Applications", icon: FileText },
    { href: "/admin/agents", label: "Companies", icon: Bot },
    { href: "/admin/purchases", label: "Purchases", icon: ShoppingCart },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border bg-white/80 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-8">
            <Link href="/admin" className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center bg-[#ee6018] rounded-none">
                <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                  <path fillRule="evenodd" clipRule="evenodd" d="M21.5 11.78H26.5L36.5 37.3H32.5L28.85 28H19.15L15.5 37.3H11.5L21.5 11.78ZM24 15.63L20.52 24.5H27.48L24 15.63Z" fill="currentColor" className="text-white"/>
                </svg>
              </div>
              <span className="text-sm font-bold tracking-tight">AI Combinator</span>
              <span className="inline-flex items-center gap-1 rounded-none bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-700">
                <ShieldAlert className="h-3 w-3" />
                Admin
              </span>
            </Link>
            <nav className="flex items-center gap-1">
              {navItems.map((item) => {
                const isActive =
                  item.href === "/admin"
                    ? pathname === "/admin"
                    : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`relative inline-flex items-center gap-1.5 rounded-none px-3.5 py-1.5 text-sm font-medium transition-all duration-200 ${
                      isActive
                        ? "bg-accent-orange/10 text-accent-orange"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    }`}
                  >
                    <item.icon className="h-3.5 w-3.5" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/portfolio"
              className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Back to Dashboard
            </Link>
            <UserButton afterSignOutUrl="/" />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
