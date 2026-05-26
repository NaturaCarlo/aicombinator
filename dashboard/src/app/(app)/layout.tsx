export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-screen overflow-hidden bg-background">{children}</div>;
}
