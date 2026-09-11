import Link from "next/link";
import { notFound } from "next/navigation";
import { getNextCall, getCampaignCallingReport, listCallers } from "@/lib/queries/calling";
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
  const { caller } = await searchParams;

  const [next, report, callers] = await Promise.all([
    getNextCall(id, caller ?? null),
    getCampaignCallingReport(id),
    listCallers({ activeOnly: true }),
  ]);

  if (!next) {
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
        <EmptyState
          title="Fronta je prázdná"
          description="Nikdo další k volání není: buď jsou všichni vyřízení, vyčerpali pokusy, nemají telefon, nebo mají callback až na později."
          action={{ href: "/volani", label: "Zpět na kampaně" }}
        />
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
            callers={callers.map((c) => ({ id: c.id, name: c.name }))}
          />
          {callers.length === 0 ? (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Není zadaný žádný caller. Hovory se uloží bez přiřazení — přidejte callera v sekci{" "}
              <Link href="/calleri" className="underline">Calleři</Link>.
            </p>
          ) : null}

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
