import Link from "next/link";
import { getHeldCall, listCallQueue, listCallers } from "@/lib/queries/calling";
import { getCompanyContext } from "@/lib/queries/companies";
import { getSelectedCallerId } from "@/lib/caller-session";
import { clearCallerAction, nextCallAction } from "@/lib/actions";
import { PageHeader, EmptyState } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { CallWorkspace } from "@/components/call-workspace";
import { CallerPicker } from "@/components/caller-picker";
import { OsloveniTabs } from "@/components/osloveni-tabs";
import { plural } from "@/lib/plan";

export const dynamic = "force-dynamic";

/**
 * Denní pracovní prostředí. Napříč kampaněmi: člověk, který sem přijde,
 * potřebuje vědět komu zavolat a proč, ne pod jakou kampaň to spadá.
 *
 * Rezervace kontaktu vzniká výhradně z akce (výběr člověka nebo zápis
 * výsledku), nikdy ze samotného renderu - jinak by prefetch zablokoval
 * firmu, kterou nikdo neviděl.
 */
export default async function OsloveniPage() {
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
          <CallerPicker campaignId="" next="/osloveni" callers={team.map((c) => ({ id: c.id, name: c.name }))} />
        )}
      </>
    );
  }

  const [held, queue] = await Promise.all([
    getHeldCall(null, caller.id),
    listCallQueue(null, { limit: 50, callerId: caller.id }),
  ]);

  const company = await getCompanyContext(held?.prospect.company_id ?? null);

  return (
    <>
      <PageHeader
        title="Oslovení"
        description={`Zpracovává ${caller.name}. Ve frontě ${plural(queue.length, "kontakt", "kontakty", "kontaktů")}.`}
        actions={
          <ActionForm action={clearCallerAction} hideMessages>
            <input type="hidden" name="next" value="/osloveni" />
            {held ? <input type="hidden" name="campaign_contact_id" value={held.prospect.id} /> : null}
            <SubmitButton className="btn-secondary">Změnit osobu</SubmitButton>
          </ActionForm>
        }
      />
      <OsloveniTabs active="/osloveni" />

      {!held ? (
        queue.length === 0 ? (
          <EmptyState
            title="Na dnešek nemáte nikoho k oslovení"
            description="Jakmile připravíme nové firmy nebo nastane čas naplánovaného follow-upu, objeví se tady. Zbytek fronty najdete na záložce Fronta."
            action={{ href: "/firmy", label: "Projít firmy" }}
          />
        ) : (
          <ActionForm action={nextCallAction} className="card max-w-md p-6">
            <h2 className="section-title mb-1">Ve frontě čeká {plural(queue.length, "kontakt", "kontakty", "kontaktů")}</h2>
            <p className="mb-4 text-xs text-zinc-500">
              Kontakt se rezervuje až teď, aby ho mezitím nedostal někdo jiný. Samotné otevření
              stránky nikoho neblokuje.
            </p>
            <SubmitButton className="btn-go" pendingLabel="Načítám…">Začít</SubmitButton>
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
              context={{
                reason: company?.reason ?? null,
                companyHref: held.prospect.company_id ? `/firmy/${held.prospect.company_id}` : null,
                campaignName: held.campaign.name,
              }}
            />
            <p className="mt-3 text-xs text-zinc-500">
              <Link href={`/kontakt/${held.prospect.id}`} className="underline">
                Historie tohoto kontaktu
              </Link>
            </p>
          </div>

          <aside className="space-y-4">
            <ScriptPanel title="Úvod" text={held.script.opening} />
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
