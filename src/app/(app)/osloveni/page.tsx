import Link from "next/link";
import { getCallerDayProgress, getHeldCall, listCallers } from "@/lib/queries/calling";
import { getSelectedCallerId } from "@/lib/caller-session";
import { clearCallerAction, nextCallAction } from "@/lib/actions";
import { PageHeader, EmptyState } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CallWorkspace } from "@/components/call-workspace";
import { CallerPicker } from "@/components/caller-picker";
import { OsloveniTabs } from "@/components/osloveni-tabs";
import { WorkProgress } from "@/components/work-progress";
import { buildCallBriefing } from "@/lib/briefing";
import { getUnloggedCall } from "@/lib/queries/calls";
import { buildCockpitBriefing } from "@/lib/telephony/briefing";
import { CallRecovery } from "@/components/call/call-recovery";
import { isTwilioConfigured } from "@/lib/telephony/twilio";
import { plural } from "@/lib/plan";

export const dynamic = "force-dynamic";

/**
 * Denní pracovní režim. Jedna firma na obrazovce, jeden hovor, jeden výsledek,
 * a další firma se načte sama - žádné proklikávání mezi tabulkou a detailem.
 *
 * Napříč kampaněmi: člověk, který sem přijde, potřebuje vědět komu zavolat
 * a proč, ne pod jakou kampaň to spadá.
 *
 * Rezervace kontaktu vzniká výhradně z akce (výběr člověka nebo zápis
 * výsledku), nikdy ze samotného renderu - jinak by prefetch zablokoval
 * firmu, kterou nikdo neviděl.
 */
export default async function OsloveniPage({
  searchParams,
}: {
  searchParams: Promise<{ rezim?: string }>;
}) {
  const { rezim } = await searchParams;
  // Pracovní režim přichází z bloku v plánu. Neznámá hodnota = celá fronta.
  const mode = rezim === "prvni" ? "first" : rezim === "followup" ? "followup" : null;
  const backHref = mode ? `/osloveni?rezim=${rezim}` : "/osloveni";
  const modeLabel =
    mode === "first" ? "První oslovení" : mode === "followup" ? "Follow-up" : null;

  const [selectedCallerId, team] = await Promise.all([
    getSelectedCallerId(),
    listCallers({ activeOnly: true }),
  ]);
  const caller = team.find((c) => c.id === selectedCallerId) ?? null;

  if (!caller) {
    return (
      <>
        <PageHeader title="Oslovení" description="Kdo dnes zpracovává frontu." />
        <OsloveniTabs active="/osloveni" />
        {team.length === 0 ? (
          <EmptyState
            title="Zatím tu není nikdo z týmu"
            description="Oslovení se zapisuje na konkrétního člověka. Přidejte někoho do týmu a můžete začít."
            action={{ href: "/tym", label: "Přidat do týmu" }}
          />
        ) : (
          <CallerPicker campaignId="" next={backHref} callers={team.map((c) => ({ id: c.id, name: c.name }))} />
        )}
      </>
    );
  }

  const [held, progress, unlogged] = await Promise.all([
    getHeldCall(null, caller.id),
    getCallerDayProgress(caller.id, null, mode),
    // Hovor, který proběhl, ale výsledek se nestihl zapsat - typicky
    // zavřený notebook hned po zavěšení.
    getUnloggedCall({ callerId: caller.id }),
  ]);
  const recovery = unlogged
    ? {
        call: unlogged,
        qualification: (
          await buildCockpitBriefing({
            contactId: unlogged.contact_id,
            companyId: unlogged.company_id,
            campaignContactId: unlogged.campaign_contact_id,
          })
        ).qualification,
      }
    : null;
  const briefing = held
    ? await buildCallBriefing(held.prospect, held.campaign.name, {
        callerName: caller.name,
        campaignOpening: held.script.opening,
      })
    : null;
  // Jestli jde volat z prohlížeče, ví server.
  const browserCalling = isTwilioConfigured();

  return (
    <>
      <PageHeader
        title={modeLabel ? `Dnes · ${modeLabel}` : "Dnes"}
        description={`Zpracovává ${caller.name}.`}
        actions={
          <ActionForm action={clearCallerAction} hideMessages>
            <input type="hidden" name="next" value={backHref} />
            {held ? <input type="hidden" name="campaign_contact_id" value={held.prospect.id} /> : null}
            <SubmitButton className="btn-secondary">Změnit osobu</SubmitButton>
          </ActionForm>
        }
      />
      <OsloveniTabs active="/osloveni" />

      {recovery ? (
        <CallRecovery
          callId={recovery.call.id}
          campaignContactId={recovery.call.campaign_contact_id}
          contactId={recovery.call.contact_id}
          contactName={recovery.call.contact_name}
          companyName={recovery.call.company_name}
          qualification={recovery.qualification}
        />
      ) : null}

      <WorkProgress
        processed={progress.processed}
        total={progress.total}
        metrics={{
          attempts: progress.attempts,
          connected: progress.connected,
          meetings: progress.meetings,
        }}
      />

      {!held ? (
        progress.remaining === 0 ? (
          <EmptyState
            title={progress.processed > 0 ? "Pro dnešek hotovo" : "Na dnešek nemáte nikoho k oslovení"}
            description={
              progress.processed > 0
                ? `Dnes jste udělali ${progress.attempts} ${plural(progress.attempts, "pokus", "pokusy", "pokusů")}, ` +
                  `dovolali se ${progress.connected}× a domluvili ${plural(progress.meetings, "schůzku", "schůzky", "schůzek")}. ` +
                  "Další follow-upy se objeví, až nastane jejich čas."
                : "Jakmile připravíme nové firmy nebo nastane čas naplánovaného follow-upu, objeví se tady. Zbytek fronty najdete na záložce Fronta."
            }
            action={{ href: "/firmy", label: "Projít firmy" }}
          />
        ) : (
          <ActionForm action={nextCallAction} className="card max-w-md p-6">
            {mode ? <input type="hidden" name="mode" value={mode} /> : null}
            <h2 className="section-title mb-1">
              Ve frontě čeká {plural(progress.remaining, "firma", "firmy", "firem")}
            </h2>
            <p className="mb-4 text-xs text-zinc-500">
              Kontakt se rezervuje až teď, aby ho mezitím nedostal někdo jiný. Samotné otevření
              stránky nikoho neblokuje.
            </p>
            <SubmitButton className="btn-go" pendingLabel="Načítám…">Začít oslovovat</SubmitButton>
          </ActionForm>
        )
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div>
            <CallWorkspace
              prospect={held.prospect}
              remaining={held.remaining}
              maxAttempts={held.campaign.max_call_attempts}
              qualificationCriteria={held.script.qualification}
              callerName={caller.name}
              campaignScope=""
              mode={mode}
              browserCalling={browserCalling}
              briefing={briefing ?? undefined}
            />
            <p className="mt-3 text-xs text-zinc-500">
              <Link href={`/kontakt/${held.prospect.id}`} className="underline">
                Celá historie tohoto kontaktu
              </Link>
            </p>
          </div>

          {/* Úvodní věta tu schválně není: je v „Jak začít“ přímo nad
              tlačítkem Zavolat, kde ji caller čte. Dvakrát tentýž text by
              ho jen nutil porovnávat, jestli se náhodou neliší. */}
          <aside className="space-y-4">
            <ScriptPanel title="Hodnota / nabídka" text={held.script.value} />
            <ScriptPanel title="Námitky" text={held.script.objections} />
            <ScriptPanel title="Zakončení" text={held.script.closing} />
            <ScriptPanel title="Kritéria kvalifikace" text={held.script.qualification} highlight />
          </aside>
        </div>
      )}
    </>
  );
}

function ScriptPanel({ title, text, highlight }: { title: string; text: string | null; highlight?: boolean }) {
  if (!text) return null;
  return (
    <div className={`card p-4 ${highlight ? "border-emerald-200 bg-emerald-50/50" : ""}`}>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h2>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800">{text}</p>
    </div>
  );
}
