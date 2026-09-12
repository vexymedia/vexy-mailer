import Link from "next/link";
import { listCallQueue, listCallers } from "@/lib/queries/calling";
import { listWorkBlocks } from "@/lib/queries/plan";
import { ACTIVITY_TYPE_LABELS, addDays, isoDate, plural, startOfWeek, type ActivityType } from "@/lib/plan";
import { minutesToHHMM } from "@/lib/schedule";
import { deleteWorkBlockAction } from "@/lib/actions";
import { PageHeader } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { OsloveniTabs } from "@/components/osloveni-tabs";
import { WorkBlockForm } from "@/components/work-block-form";

export const dynamic = "force-dynamic";

const DAY_NAMES = ["Pondělí", "Úterý", "Středa", "Čtvrtek", "Pátek", "Sobota", "Neděle"];

/**
 * Týdenní plán obchodní kapacity.
 *
 * Plánují se bloky práce, ne jednotlivé telefonáty, a plán je propojený
 * s frontou: u bloku je vidět, kolik kontaktů čeká, a tlačítko vede rovnou
 * do zpracování. Není to náhrada kalendáře schůzek.
 */
export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ tyden?: string }>;
}) {
  const { tyden } = await searchParams;
  const base = tyden && /^\d{4}-\d{2}-\d{2}$/.test(tyden) ? new Date(`${tyden}T00:00:00Z`) : new Date();
  const weekStart = startOfWeek(base);

  const [blocks, team, queue] = await Promise.all([
    listWorkBlocks(weekStart),
    listCallers({ activeOnly: true }),
    listCallQueue(null, { limit: 500 }),
  ]);

  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const today = isoDate(new Date());
  const byDay = new Map<string, typeof blocks>();
  for (const block of blocks) {
    const key = isoDate(new Date(block.block_date));
    byDay.set(key, [...(byDay.get(key) ?? []), block]);
  }

  const weekLabel = `${isoDate(weekStart).slice(8)}. ${isoDate(weekStart).slice(5, 7)}. – ${isoDate(addDays(weekStart, 6)).slice(8)}. ${isoDate(addDays(weekStart, 6)).slice(5, 7)}. ${isoDate(weekStart).slice(0, 4)}`;

  return (
    <>
      <PageHeader
        title="Plán"
        description="Kdy kdo zpracovává frontu. Plánují se bloky práce, ne jednotlivé hovory."
        actions={
          <>
            <Link href={`/osloveni/plan?tyden=${isoDate(addDays(weekStart, -7))}`} className="btn-secondary">
              ← Předchozí
            </Link>
            <Link href="/osloveni/plan" className="btn-secondary">Tento týden</Link>
            <Link href={`/osloveni/plan?tyden=${isoDate(addDays(weekStart, 7))}`} className="btn-secondary">
              Další →
            </Link>
          </>
        }
      />
      <OsloveniTabs active="/osloveni/plan" />

      <p className="mb-4 text-sm text-zinc-500">
        Týden {weekLabel} · ve frontě {plural(queue.length, "kontakt", "kontakty", "kontaktů")}
      </p>

      <div className="mb-6 grid gap-3 lg:grid-cols-7">
        {days.map((day, index) => {
          const key = isoDate(day);
          const dayBlocks = byDay.get(key) ?? [];
          const isToday = key === today;
          return (
            <div
              key={key}
              className={`card flex min-h-40 flex-col p-3 ${isToday ? "border-zinc-900 ring-1 ring-zinc-900/10" : ""}`}
            >
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className={`text-sm font-medium ${isToday ? "text-zinc-900" : "text-zinc-700"}`}>
                  {DAY_NAMES[index]}
                </span>
                <span className="text-xs text-zinc-400">
                  {key.slice(8)}.{key.slice(5, 7)}.
                </span>
              </div>

              {dayBlocks.length === 0 ? (
                <p className="mt-1 text-xs text-zinc-400">—</p>
              ) : (
                <ul className="space-y-2">
                  {dayBlocks.map((block) => (
                    <li key={block.id} className="rounded-md border border-zinc-200 bg-zinc-50/70 p-2.5">
                      <p className="text-xs font-medium tabular-nums text-zinc-900">
                        {minutesToHHMM(block.start_minute)}–{minutesToHHMM(block.end_minute)}
                      </p>
                      <p className="mt-0.5 text-sm text-zinc-900">{block.caller_name ?? "Nepřiřazeno"}</p>
                      <p className="text-xs text-zinc-500">
                        {ACTIVITY_TYPE_LABELS[block.activity_type as ActivityType] ?? block.activity_type}
                      </p>
                      {block.note ? <p className="mt-1 text-xs text-zinc-500">{block.note}</p> : null}

                      {block.activity_type === "calling" || block.activity_type === "follow_up" ? (
                        <div className="mt-2 flex items-center justify-between gap-2">
                          <span className="text-xs text-zinc-500">{queue.length} ve frontě</span>
                          <Link href="/osloveni" className="btn-go !px-2 !py-1 text-xs">Začít</Link>
                        </div>
                      ) : null}

                      <ActionForm action={deleteWorkBlockAction} hideMessages className="mt-2">
                        <input type="hidden" name="id" value={block.id} />
                        <SubmitButton
                          className="text-xs text-zinc-400 transition-colors hover:text-red-600"
                          confirm="Smazat tento blok z plánu?"
                        >
                          Smazat
                        </SubmitButton>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {team.length === 0 ? (
        <p className="card px-5 py-6 text-sm text-zinc-500">
          Bloky se přiřazují lidem z týmu.{" "}
          <Link href="/tym" className="underline">Přidejte někoho do týmu</Link>, ať je komu plánovat.
        </p>
      ) : null}

      <WorkBlockForm defaultDate={today} team={team.map((c) => ({ id: c.id, name: c.name }))} />

      <p className="mt-4 text-xs text-zinc-500">
        Plán rozvrhuje kapacitu. Koho konkrétně volat, rozhoduje fronta podle priority
        a naplánovaných follow-upů.
      </p>
    </>
  );
}
