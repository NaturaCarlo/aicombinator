import { LaunchForm } from "@/components/launch-form";
import { PageShell } from "@/components/shared/page-shell";

export default function LaunchPage() {
  return (
    <PageShell flush>
      <LaunchForm />
    </PageShell>
  );
}
