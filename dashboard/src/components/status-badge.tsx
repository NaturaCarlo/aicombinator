import { Badge } from "@/components/ui/badge";
import type { CompanyState } from "@/lib/types";

const stateConfig: Record<
  CompanyState,
  { label: string; dotColor: string; bgColor: string; textColor: string; animated: boolean }
> = {
  awaiting_funding: {
    label: "Awaiting Funding",
    dotColor: "bg-accent-amber",
    bgColor: "bg-accent-amber/10",
    textColor: "text-accent-amber",
    animated: true,
  },
  provisioning: {
    label: "Provisioning",
    dotColor: "bg-foreground",
    bgColor: "bg-secondary",
    textColor: "text-foreground",
    animated: true,
  },
  planning: {
    label: "Planning",
    dotColor: "bg-foreground",
    bgColor: "bg-secondary",
    textColor: "text-foreground",
    animated: true,
  },
  running: {
    label: "Running",
    dotColor: "bg-accent-green",
    bgColor: "bg-accent-green/10",
    textColor: "text-accent-green",
    animated: true,
  },
  completed: {
    label: "Completed",
    dotColor: "bg-accent-green",
    bgColor: "bg-accent-green/10",
    textColor: "text-accent-green",
    animated: false,
  },
  sleeping: {
    label: "Sleeping",
    dotColor: "bg-muted-foreground/50",
    bgColor: "bg-secondary",
    textColor: "text-muted-foreground",
    animated: false,
  },
  paused: {
    label: "Paused",
    dotColor: "bg-muted-foreground/50",
    bgColor: "bg-secondary",
    textColor: "text-muted-foreground",
    animated: false,
  },
  failed: {
    label: "Failed",
    dotColor: "bg-accent-red",
    bgColor: "bg-accent-red/10",
    textColor: "text-accent-red",
    animated: false,
  },
  dead: {
    label: "Dead",
    dotColor: "bg-muted-foreground/40",
    bgColor: "bg-secondary",
    textColor: "text-muted-foreground",
    animated: false,
  },
};

const unknownConfig = {
  label: "Unknown",
  dotColor: "bg-muted-foreground/30",
  bgColor: "bg-secondary",
  textColor: "text-muted-foreground",
  animated: false,
};

export function StatusBadge({ state }: { state: CompanyState }) {
  const config = stateConfig[state] || unknownConfig;

  return (
    <Badge
      variant="ghost"
      className={`gap-1.5 border-transparent px-2.5 py-1 text-xs font-semibold ${config.bgColor} ${config.textColor}`}
    >
      <span className="relative flex h-1.5 w-1.5">
        {config.animated && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-none ${config.dotColor} opacity-50`} />
        )}
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-none ${config.dotColor}`} />
      </span>
      {config.label}
    </Badge>
  );
}
