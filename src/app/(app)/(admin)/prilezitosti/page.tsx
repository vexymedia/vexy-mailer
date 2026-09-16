import Link from "next/link";
import { listOpportunities } from "@/lib/queries/opportunities";
import { listCallingCampaigns } from "@/lib/queries/calling";
import { PageHeader, DateTime, EmptyState } from "@/components/ui";
import { CopyHandoff } from "@/components/copy-handoff";
import { formatWhen } from "@/lib/datetime";

export const dynamic = "force-dynamic";

/**
 * Příležitosti k předání klientovi.
 *
 * Poslední krok toho, co VEXY prodává: „vybrali jsme lidi, oslovili je
 * a tady jsou jednání, která má váš obchodník převzít."
 *
 * Je to čtecí pohled nad daty, která už existují - stav volání, poznámka
 * operátora, termín schůzky, pozitivně označené vlákno. Žádná nová
 * entita, žádná automatická klasifikace. Kdo sem patří, rozhodl člověk
 * tím, že uložil výsledek hovoru nebo označil odpověď za pozitivní.
 */
export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string }>;
}) {
  const { campaign } = await searchParams;
  // Neplatná hodnota z adresy nesmí shodit stránku - filtr se prostě
  // neuplatní. Je to volitelné zúžení, ne identita entity.
  const campaignId = /^[0-9a-f-]{36}$/i.test(campaign ?? "") ? campaign! : null;

  const [opportunities, campaigns] = await Promise.all([
    listOpportunities({ campaignId }),
    listCallingCampaigns(),
  ]);

  return (
    <>
      <PageHeader
        title="Příležitosti"
        description="Jednání připravená k předání klientovi. Schůzky, získaní klienti a pozitivní odpovědi."
      />

      {campaigns.length > 1 ? (
        <div className="mb-5 flex flex-wrap gap-2">
          <Link
            href="/prilezitosti"
            className={`badge ${campaignId ? "bg-zinc-100 text-zinc-600 ring-zinc-200" : "bg-zinc-900 text-white ring-zinc-900"}`}
          >
            Všechny kampaně
          </Link>
          {campaigns.map((c) => (
            <Link
              key={c.id}
              href={`/prilezitosti?campaign=${c.id}`}
              className={`badge ${campaignId === c.id ? "bg-zinc-900 text-white ring-zinc-900" : "bg-zinc-100 text-zinc-600 ring-zinc-200"}`}
            >
              {c.name}
            </Link>
          ))}
        </div>
      ) : null}

      {opportunities.length === 0 ? (
        <EmptyState
          title="Zatím žádná příležitost"
          description="Objeví se tu schůzka, získaný klient nebo konverzace označená jako pozitivní."
        />
      ) : (
        <ul className="space-y-4">
          {opportunities.map((o) => {
            const name = o.contact_name ?? o.email;
            // Souhrn ke zkopírování: všechno, co klient potřebuje, aby
            // mohl navázat - bez otevírání dalších obrazovek.
            const handoff = [
              `${name}${o.position ? `, ${o.position}` : ""}`,
              o.company ? `Firma: ${o.company}` : null,
              `E-mail: ${o.email}`,
              o.phone ? `Telefon: ${o.phone}` : null,
              o.client_name ? `Klient: ${o.client_name}` : null,
              `Kampaň: ${o.campaign_name}`,
              o.meeting_at ? `Schůzka: ${formatWhen(o.meeting_at)}` : null,
              o.next_call_at ? `Další kontakt: ${formatWhen(o.next_call_at)}` : null,
              o.positive_reply ? "Odpověděl e-mailem (označeno jako pozitivní)." : null,
              o.call_note ? `Z hovoru: ${o.call_note}` : null,
            ]
              .filter(Boolean)
              .join("\n");

            return (
              <li key={o.campaign_contact_id} className="card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900">{name}</p>
                    <p className="text-xs text-zinc-600">
                      {o.position ? `${o.position} · ` : ""}
                      {o.company ?? "bez firmy"}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {o.call_status === "meeting_booked" ? (
                      <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">Schůzka</span>
                    ) : null}
                    {o.call_status === "won" ? (
                      <span className="badge bg-emerald-600 text-white ring-emerald-600">Získaný klient</span>
                    ) : null}
                    {o.positive_reply ? (
                      <span className="badge bg-blue-50 text-blue-700 ring-blue-200">Pozitivní odpověď</span>
                    ) : null}
                  </div>
                </div>

                <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="text-zinc-500">E-mail</dt>
                    <dd className="truncate text-zinc-900">{o.email}</dd>
                  </div>
                  {o.phone ? (
                    <div className="flex gap-2">
                      <dt className="text-zinc-500">Telefon</dt>
                      <dd className="tabular-nums text-zinc-900">{o.phone}</dd>
                    </div>
                  ) : null}
                  <div className="flex gap-2">
                    <dt className="text-zinc-500">Klient</dt>
                    <dd className="truncate text-zinc-900">{o.client_name ?? "—"}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-zinc-500">Kampaň</dt>
                    <dd className="truncate text-zinc-900">{o.campaign_name}</dd>
                  </div>
                  {o.meeting_at ? (
                    <div className="flex gap-2">
                      <dt className="text-zinc-500">Schůzka</dt>
                      <dd className="text-zinc-900">
                        <DateTime value={o.meeting_at} />
                      </dd>
                    </div>
                  ) : null}
                  {o.next_call_at ? (
                    <div className="flex gap-2">
                      <dt className="text-zinc-500">Další kontakt</dt>
                      <dd className="text-zinc-900">
                        <DateTime value={o.next_call_at} />
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {o.call_note ? (
                  <p className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
                    {o.call_note}
                  </p>
                ) : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href={`/volani/${o.campaign_contact_id}`} className="btn-secondary !px-2.5 !py-1 text-xs">
                    Detail a historie
                  </Link>
                  {o.conversation_id ? (
                    <Link href={`/inbox/${o.conversation_id}`} className="btn-secondary !px-2.5 !py-1 text-xs">
                      Konverzace
                    </Link>
                  ) : null}
                  {o.company_id ? (
                    <Link href={`/firmy/${o.company_id}`} className="btn-secondary !px-2.5 !py-1 text-xs">
                      Firma
                    </Link>
                  ) : null}
                  <CopyHandoff text={handoff} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
