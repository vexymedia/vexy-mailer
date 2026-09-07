import { getSettings } from "@/lib/settings";
import { PageHeader } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";
import { appUrl } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <>
      <PageHeader title="Settings" />
      <div className="max-w-2xl space-y-6">
        <SettingsForm
          testMode={settings.test_mode}
          testEmail={settings.test_email ?? ""}
          testBehavior={settings.test_behavior}
        />

        <div className="card p-6">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Worker</h2>
          <p className="text-sm text-zinc-600">
            The sending engine runs when something calls the tick endpoint. It is idempotent, so
            calling it more often than needed is harmless.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-zinc-900 px-4 py-3 font-mono text-xs text-zinc-100">
            {`curl -X POST "${appUrl()}/api/cron/tick" \\
  -H "Authorization: Bearer $CRON_SECRET"`}
          </pre>
          <p className="mt-3 text-xs text-zinc-500">
            On Vercel this is wired up by <code className="font-mono">vercel.json</code> to run every
            minute. See <code className="font-mono">docs/DEPLOY.md</code> for the alternatives.
          </p>
        </div>
      </div>
    </>
  );
}
