import Link from "next/link";
import { notFound } from "next/navigation";
import { getHeldCall, getCampaignCallingReport, listCallers } from "@/lib/queries/calling";
import { getSelectedCallerId } from "@/lib/caller-session";
import { CallerPicker } from "@/components/caller-picker";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { clearCallerAction, nextCallAction } from "@/lib/actions";
import { PageHeader, EmptyState, Stat } from "@/components/ui";
import { CallWorkspace } from "@/components/call-workspace";

export const dynamic = "force-dynamic";

/**
 * The caller's whole working day. One prospect at a time, the script beside it,
 * and the next prospect loaded by the page itself after each saved outcome.
 */
export default async function CallerWorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ caller?: string }>;
}) {
  const { id } = await params;
  await searchParams;

  const [selectedCallerId, callers] = await Promise.all([
    getSelectedCallerId(),
    listCallers({ activeOnly: true }),
  ]);
  const caller = callers.find((c) => c.id === selectedCallerId) ?? null;

  // Nobody can be handed a prospect until we know who is holding them, so the
  // caller is asked first and the queue is not touched before that.
  if (!caller) {
    const [campaign] = await import("@/lib/db").then(({ sql }) =>
      sql<{ name: string }[]>`select name from campaigns where id = ${id}`,
    );
    if (!campaign) notFound();
    return (
      <>
        <PageHeader
          title={campaign.name}
          description="Fronta volání"
          actions={<Link href={`/campaigns/${id}?tab=volani`} className="btn-secondary">Přehled kampaně</Link>}
        />
        {callers.length === 0 ? (
          <EmptyState
            title="Není zadaný žádný caller"
            description="Volání se zapisuje na konkrétního callera. Nejdřív někoho přidejte."
            action={{ href: "/calleri", label: "Přidat callera" }}
          />
        ) : (
          <CallerPicker campaignId={id} callers={callers.map((c) => ({ id: c.id, name: c.name }))} />
        )}
      </>
    );
  }

  // Read-only: the workspace shows whichever prospect this caller already
  // holds. Taking a lease is an action, never a render - a prefetch of this
  // page must not reserve anybody.
  const [next, report] = await Promise.all([
    getHeldCall(id, caller.id),
    getCampaignCallingReport(id),
  ]);

  // Nothing held: either the shift is starting, the lease ran out while the
  // caller was away, or the queue is empty. The first two are one press away;
  // the third has nothing to press.
  if (!next) {
    const [campaign] = await import("@/lib/db").then(({ sql }) =>
      sql<{ name: string }[]>`select name from campaigns where id = ${id}`,
    );
    if (!campaign) notFound();
    return (
      <>
        <PageHeader
          title={campaign.name}
          description={`Volá ${caller.name}`}
          actions={<Link href={`/campaigns/${id}?tab=volani`} className="btn-secondary">Přehled kampaně</Link>}
        />
        {report.queue_size === 0 ? (
          <EmptyState
            title="Fronta je prázdná"
            description="Nikdo další k volání není: buď jsou všichni vyřízení, vyčerpali pokusy, nemají telefon, nebo mají callback až na později."
            action={{ href: "/volani", label: "Zpět na kampaně" }}
          />
        ) : (
          <ActionForm action={nextCallAction} className="card max-w-md p-6">
            <input type="hidden" name="campaign_id" value={id} />
            <h2 className="mb-1 text-sm font-semibold text-zinc-900">
              Ve frontě čeká {report.queue_size} kontaktů
            </h2>
            <p className="mb-4 text-xs text-zinc-500">
              Kontakt se rezervuje až teď, aby ho mezitím nedostal jiný caller. Samotné otevření
              stránky nikoho neblokuje.
            </p>
            <SubmitButton className="btn-go" pendingLabel="Načítám…">
              Načíst další kontakt
            </SubmitButton>
          </ActionForm>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={next.campaign.name}
        description="Vytočit číslo, zapsat výsledek, další kontakt se načte sám."
        actions={
          <>
            <ActionForm action={clearCallerAction} hideMessages>
              <input type="hidden" name="campaign_id" value={id} />
              <input type="hidden" name="campaign_contact_id" value={next.prospect.id} />
              <SubmitButton className="btn-secondary">Volá {caller.name} — změnit</SubmitButton>
            </ActionForm>
            <Link href={`/campaigns/${id}?tab=volani`} className="btn-secondary">Přehled kampaně</Link>
            <Link href="/volani" className="btn-secondary">Jiná kampaň</Link>
          </>
        }
      />

      <div className="card mb-6 grid grid-cols-2 gap-6 p-5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Ve frontě" value={report.queue_size} />
        <Stat label="Callbacky dnes" value={report.callbacks_due} />
        <Stat label="Dovolané hovory" value={report.counts.connected_calls} />
        <Stat
          label="Schůzky"
          value={report.counts.meetings_booked}
          tone={report.counts.meetings_booked > 0 ? "good" : undefined}
        />
        <Stat label="Kvalifikované" value={report.counts.meetings_qualified} />
        <Stat label="Uskutečněné" value={report.counts.meetings_held} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div>
          <CallWorkspace
            prospect={next.prospect}
            remaining={next.remaining}
            maxAttempts={next.campaign.max_call_attempts}
            qualificationCriteria={next.script.qualification}
            callerName={caller.name}
          />
          <p className="mt-3 text-xs text-zinc-500">
            <Link href={`/kontakt/${next.prospect.id}`} className="underline">
              Historie tohoto kontaktu
            </Link>{" "}
            — hovory i e-maily.
          </p>
        </div>

        <aside className="space-y-4">
          <ScriptPanel title="Úvod" text={next.script.opening} />
          <ScriptPanel title="Hodnota / nabídka" text={next.script.value} />
          <ScriptPanel title="Námitky" text={next.script.objections} />
          <ScriptPanel title="Zakončení" text={next.script.closing} />
          <ScriptPanel title="Kritéria kvalifikace" text={next.script.qualification} highlight />
          {!next.script.opening &&
          !next.script.value &&
          !next.script.objections &&
          !next.script.closing ? (
            <p className="px-1 text-xs text-zinc-500">
              Skript zatím není vyplněný. Doplňte ho v{" "}
              <Link href={`/campaigns/${id}?tab=volani`} className="underline">
                nastavení volání
              </Link>
              .
            </p>
          ) : null}
        </aside>
      </div>
    </>
  );
}

function ScriptPanel({ title, text, highlight }: { title: string; text: string | null; highlight?: boolean }) {
  if (!text) return null;
  return (
    <div className={`card p-4 ${highlight ? "border-emerald-200 bg-emerald-50/50" : ""}`}>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800">{text}</p>
    </div>
  );
}
