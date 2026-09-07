import { requireAuth } from "@/lib/auth";
import { Nav } from "@/components/nav";
import { TestModeBanner } from "@/components/test-mode-banner";

export const dynamic = "force-dynamic";

/**
 * Every authenticated page lives under this group, so the auth check and the
 * test-mode banner cannot be forgotten on a new screen.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireAuth();
  return (
    <div className="min-h-screen">
      <TestModeBanner />
      <Nav />
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
