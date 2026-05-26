"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { SidebarAccountMenu } from "@/components/shared/sidebar-account-menu";

function initialsFor(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

export function AccountMenuTrigger({
  founderName,
  imageUrl,
  open,
  onClick,
  compact = false,
  mobile = false,
}: {
  founderName: string;
  imageUrl?: string | null;
  open: boolean;
  onClick: () => void;
  compact?: boolean;
  mobile?: boolean;
}) {
  const buttonClassName = mobile
    ? "inline-flex items-center gap-2 rounded-none border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground"
    : "flex w-full items-center gap-2 text-left";
  const avatarClassName = compact ? "h-8 w-8" : mobile ? "h-5 w-5" : "h-8 w-8";
  const fallbackTextClassName = compact || !mobile ? "text-xs" : "text-[10px]";

  return (
    <button type="button" onClick={onClick} className={buttonClassName}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={founderName}
          className={`${avatarClassName} shrink-0 rounded-none object-cover`}
        />
      ) : (
        <div
          className={`flex ${avatarClassName} shrink-0 items-center justify-center rounded-none bg-secondary font-semibold text-muted-foreground ${fallbackTextClassName}`}
        >
          {initialsFor(founderName)}
        </div>
      )}
      <div className="pointer-events-none flex min-w-0 flex-1 items-center justify-between gap-2 text-left">
        <span className={`min-w-0 truncate ${compact ? "text-xs text-muted-foreground" : mobile ? "max-w-24 text-xs text-muted-foreground" : "text-xs text-muted-foreground"}`}>
          {founderName}
        </span>
        {open ? (
          <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>
    </button>
  );
}

export function AccountMenuPanel({
  currentCompanyId,
  compact = false,
  className = "",
}: {
  currentCompanyId?: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <SidebarAccountMenu currentCompanyId={currentCompanyId} compact={compact} />
    </div>
  );
}
