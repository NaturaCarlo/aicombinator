import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { PortfolioPage } from "@/components/portfolio/portfolio-page";
import { PageShell } from "@/components/shared/page-shell";

export default function PortfolioRoute() {
  return (
    <Suspense fallback={<PortfolioPageLoading />}>
      <PortfolioPage />
    </Suspense>
  );
}

function PortfolioPageLoading() {
  return (
    <PageShell>
      <div className="flex items-center justify-center py-32 fade-in-up">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    </PageShell>
  );
}
