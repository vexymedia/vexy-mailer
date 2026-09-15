import Link from "next/link";
import { listClients } from "@/lib/queries/clients";
import { sql } from "@/lib/db";
import { createClientAction, setCampaignClientAction } from "@/lib/actions";
import { PageHeader, EmptyState, StatusBadge } from "@/components/ui";
import { NastaveniTabs } from "@/components/section-tabs";
import { ActionForm, SubmitButton } from "@/components/action-form";

export const dynamic = "force-dynamic";

/**
 * Klienti a zařazení kampaní.
 *
 * Nejde o CRM zákazníků - je to hranice provozu. Kampaň pod klientem
 * určuje, čí je práce, čí jsou hovory a co uvidí caller. Kampaň bez
 * klienta zůstává jen administrátorovi; historii nikdo neuhaduje.
 */
export default async function ClientsPage() {
  const [clients, campaigns] = await Promise.all([
    listClients(),
    sql<{ id: string; name: string; status: string; client_id: string | null }[]>`
      select id, name, status, client_id from campaigns
       where status <> 'completed' order by name
    `,
  ]);

  const orphans = campaigns.filter((campaign) => !campaign.client_id);

  return (
    <>
      <PageHeader
        title="Klienti"
        description="Čí práce je která kampaň."
      />
      <NastaveniTabs active="/klienti" />

      <div className="mb-6 max-w-md">
        <ActionForm action={createClientAction} className="card p-5">
          <label className="label" htmlFor="client_name">Nový klient</label>
          <div className="flex gap-2">
            <input
              id="client_name"
              name="name"
              required
              placeholder="ASN Plus"
              className="input"
            />
            <SubmitButton pendingLabel="Ukládám…">Přidat</SubmitButton>
          </div>
        </ActionForm>
      </div>

      {orphans.length > 0 ? (
        <div className="card mb-6 border-amber-300 bg-amber-50/60 p-5">
          <h2 className="text-sm font-semibold text-amber-900">
            {orphans.length === 1 ? "Jedna kampaň nemá klienta" : `${orphans.length} kampaní nemá klienta`}
          </h2>
          <p className="mt-1 text-sm text-amber-900">
            Dokud kampaň nikam nepatří, nedá se přidělit callerovi a v reportingu
            klienta se neobjeví. Zařaďte ji níž.
          </p>
        </div>
      ) : null}

      {clients.length === 0 ? (
        <EmptyState
          title="Zatím žádný klient"
          description="Přidejte prvního výše — třeba ASN Plus a VEXY."
        />
      ) : (
        <ul className="space-y-4">
          {clients.map((client) => {
            const mine = campaigns.filter((campaign) => campaign.client_id === client.id);
            return (
              <li key={client.id} className="card p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-base font-semibold text-zinc-900">{client.name}</h2>
                  <span className="text-xs text-zinc-500">
                    {mine.length === 0
                      ? "zatím bez kampaně"
                      : `${mine.length} ${mine.length === 1 ? "kampaň" : mine.length < 5 ? "kampaně" : "kampaní"}`}
                  </span>
                </div>
                {mine.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {mine.map((campaign) => (
                      <li key={campaign.id} className="flex items-center gap-2 text-sm">
                        <Link href={`/campaigns/${campaign.id}`} className="text-zinc-900 hover:underline">
                          {campaign.name}
                        </Link>
                        <StatusBadge status={campaign.status} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {campaigns.length > 0 ? (
        <section className="mt-8">
          <h2 className="section-title mb-3">Zařazení kampaní</h2>
          <ul className="card divide-y divide-zinc-100">
            {campaigns.map((campaign) => (
              <li key={campaign.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="min-w-0 flex-1 text-sm font-medium text-zinc-900">
                  {campaign.name}
                </span>
                <ActionForm action={setCampaignClientAction} hideMessages className="flex items-center gap-2">
                  <input type="hidden" name="campaign_id" value={campaign.id} />
                  {/* key podle uložené hodnoty: bez něj si prohlížeč po
                      uložení nechá starý výběr a admin nepozná, jestli se
                      změna povedla. Zprávy jsou skryté, takže remount nic
                      neztratí. */}
                  <select
                    key={campaign.client_id ?? "none"}
                    name="client_id"
                    defaultValue={campaign.client_id ?? ""}
                    className="input w-auto py-1.5 text-sm"
                  >
                    <option value="">— bez klienta —</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>{client.name}</option>
                    ))}
                  </select>
                  <SubmitButton className="btn-secondary !py-1.5 text-sm">Uložit</SubmitButton>
                </ActionForm>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
