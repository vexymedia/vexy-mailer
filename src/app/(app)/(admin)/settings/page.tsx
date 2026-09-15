import Link from "next/link";
import { getSettings } from "@/lib/settings";
import { PageHeader } from "@/components/ui";
import { SettingsForm } from "@/components/settings-form";
import { RunWorkerButton } from "@/components/run-worker-button";
import { NastaveniTabs } from "@/components/section-tabs";
import { appUrl } from "@/lib/unsubscribe";
import { CallingSettings } from "@/components/call/calling-settings";
import { missingTwilioEnv } from "@/lib/telephony/twilio";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const settings = await getSettings();
  const missingCalling = missingTwilioEnv();

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

        <CallingSettings
          configured={missingCalling.length === 0}
          missing={missingCalling}
          recordingEnabled={settings.call_recording_enabled}
          callerId={process.env.TWILIO_CALLER_ID?.trim() || null}
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
          {/* Worker se zastaví sám, když je databáze pozadu. Odkaz sem patří,
              protože právě tady se člověk ptá, proč se nic neposílá. */}
          <p className="mt-1 text-xs text-zinc-500">
            Jestli je databáze i konfigurace v pořádku, ukáže{" "}
            <Link href="/stav" className="underline hover:text-zinc-700">
              Stav systému
            </Link>
            . Dokud není, worker nic neodesílá ani nevytáčí.
          </p>
        </div>
      </div>
    </>
  );
}
