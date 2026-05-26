"use client";

import { useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import {
  AccountMenuPanel,
  AccountMenuTrigger,
} from "@/components/shared/account-menu-surface";

export function PageShell({ children, flush }: { children: React.ReactNode; flush?: boolean }) {
  const { user } = useUser();
  const [showAccountMenu, setShowAccountMenu] = useState(false);

  const founderName =
    user?.fullName?.trim()
    || user?.primaryEmailAddress?.emailAddress?.trim()
    || "Founder";

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background lg:flex">
      <aside className="hidden h-full min-h-0 w-60 shrink-0 border-r border-border bg-background lg:flex lg:flex-col">
        <div className="p-3 border-b border-border">
          <Link href="/portfolio" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center bg-[#ee6018] rounded-none">
              <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                <path fillRule="evenodd" clipRule="evenodd" d="M21.5 11.78H26.5L36.5 37.3H32.5L28.85 28H19.15L15.5 37.3H11.5L21.5 11.78ZM24 15.63L20.52 24.5H27.48L24 15.63Z" fill="currentColor" className="text-white"/>
              </svg>
            </div>
            <span className="text-sm font-bold tracking-tight">AI Combinator</span>
          </Link>
        </div>

        <div className="flex-1 min-h-0" />

        {showAccountMenu && (
          <AccountMenuPanel className="px-3 pb-3" />
        )}

        <div className="border-t border-border px-3 py-3 space-y-2">
          <AccountMenuTrigger
            founderName={founderName}
            imageUrl={user?.imageUrl}
            open={showAccountMenu}
            onClick={() => setShowAccountMenu((current) => !current)}
          />
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-50 border-b border-border bg-background/90 backdrop-blur-sm lg:hidden">
          <div className="flex h-14 items-center justify-between px-4">
            <Link href="/portfolio" className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center bg-[#ee6018] rounded-none">
                <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                  <path fillRule="evenodd" clipRule="evenodd" d="M21.5 11.78H26.5L36.5 37.3H32.5L28.85 28H19.15L15.5 37.3H11.5L21.5 11.78ZM24 15.63L20.52 24.5H27.48L24 15.63Z" fill="currentColor" className="text-white"/>
                </svg>
              </div>
              <span className="text-sm font-bold tracking-tight">AI Combinator</span>
            </Link>
            <div className="flex items-center gap-2">
              <AccountMenuTrigger
                founderName={founderName}
                imageUrl={user?.imageUrl}
                open={showAccountMenu}
                onClick={() => setShowAccountMenu((current) => !current)}
                mobile
              />
            </div>
          </div>
        </header>
        {showAccountMenu && (
          <div className="pointer-events-none fixed inset-0 z-50 lg:hidden">
            <button
              type="button"
              aria-label="Close account menu"
              className="absolute inset-0 bg-black/10"
              onClick={() => setShowAccountMenu(false)}
            />
            <div className="pointer-events-auto absolute bottom-4 left-4 w-[min(20rem,calc(100vw-2rem))]">
              <AccountMenuPanel className="rounded-none border border-border bg-background p-3 shadow-xl" />
            </div>
          </div>
        )}
        <main className="min-h-0 flex-1 overflow-y-auto">
          {flush ? children : <div className="mx-auto max-w-6xl px-4 py-6 lg:px-8 lg:py-8">{children}</div>}
        </main>
      </div>
    </div>
  );
}
