import { getSettings } from "@/lib/settings";
import { PageHeader } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";
import { RunWorkerButton } from "@/components/run-worker-button";
import { NastaveniTabs } from "@/components/section-tabs";
import { appUrl } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <>
      <PageHeader title="Nastavení" />
      <NastaveniTabs active={"/settings"} />
      <div className="max-w-2xl space-y-6">
        <SettingsForm
          testMode={settings.test_mode}
          testEmail={settings.test_email ?? ""}
          testBehavior={settings.test_behavior}
        />

        <div className="card p-6">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-900">Worker</h2>
            <RunWorkerButton />
          </div>
          <p className="text-sm text-zinc-600">
            Odesílací engine běží, když něco zavolá tick endpoint. Je idempotentní, takže volat ho
            častěji, než je potřeba, nic nerozbije.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-zinc-900 px-4 py-3 font-mono text-xs text-zinc-100">
            {`curl -X POST "${appUrl()}/api/cron/tick" \\
  -H "Authorization: Bearer $CRON_SECRET"`}
          </pre>
          <p className="mt-3 text-xs text-zinc-500">
            Na Vercelu to zařizuje <code className="font-mono">vercel.json</code> každou minutu.
            Alternativy najdete v <code className="font-mono">docs/DEPLOY.md</code>.
          </p>
        </div>
      </div>
    </>
  );
}
