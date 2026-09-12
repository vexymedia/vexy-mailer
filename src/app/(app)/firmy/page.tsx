import Link from "next/link";
import { listCompanies } from "@/lib/queries/companies";
import { COMPANY_STATUS_LABELS, type CompanyPriority, type CompanyStatus } from "@/lib/companies";
import { plural } from "@/lib/plan";
import { listCallers } from "@/lib/queries/calling";
import {
  PageHeader,
  Table,
  EmptyState,
  DateTime,
  PriorityBadge,
  CompanyStatusBadge,
} from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Seznam firem. Osm sloupců, ne patnáct: má odpovědět "koho řešit a proč",
 * ne vypsat všechno, co o firmě máme v databázi.
 */
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; priority?: string; owner?: string; fronta?: string }>;
}) {
  const params = await searchParams;
  const status = (params.status && params.status in COMPANY_STATUS_LABELS ? params.status : null) as CompanyStatus | null;
  const priority = (["high", "normal", "low"].includes(params.priority ?? "") ? params.priority : null) as CompanyPriority | null;
  const queueOnly = params.fronta === "1";

  const [{ rows, total }, team] = await Promise.all([
    listCompanies({
      search: params.q ?? null,
      status,
      priority,
      ownerId: params.owner || null,
      queueOnly,
    }),
    listCallers(),
  ]);

  const link = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { ...params, ...overrides } as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    const qs = next.toString();
    return qs ? `/firmy?${qs}` : "/firmy";
  };

  return (
    <>
      <PageHeader
        title="Firmy"
        description={`${plural(total, "firma", "firmy", "firem")}. Kontakt je člověk uvnitř firmy — rozhodujeme se o firmě.`}
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Link href={link({ status: undefined, fronta: undefined })} className={`chip ${!status && !queueOnly ? "chip-active" : ""}`}>
          Vše
        </Link>
        <Link href={link({ fronta: "1", status: undefined })} className={`chip ${queueOnly ? "chip-active" : ""}`}>
          Čeká na oslovení
        </Link>
        {(["ready", "in_progress", "interested", "meeting", "excluded"] as CompanyStatus[]).map((key) => (
          <Link key={key} href={link({ status: key, fronta: undefined })} className={`chip ${status === key ? "chip-active" : ""}`}>
            {COMPANY_STATUS_LABELS[key]}
          </Link>
        ))}

        <form className="ml-auto flex flex-wrap items-center gap-2">
          {status ? <input type="hidden" name="status" value={status} /> : null}
          {queueOnly ? <input type="hidden" name="fronta" value="1" /> : null}
          <select name="owner" defaultValue={params.owner ?? ""} className="input w-auto py-1.5 text-sm">
            <option value="">Kdokoliv</option>
            {team.map((member) => (
              <option key={member.id} value={member.id}>{member.name}</option>
            ))}
          </select>
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Hledat firmu, důvod nebo kontakt…"
            className="input w-auto py-1.5 text-sm"
          />
          <button type="submit" className="btn-secondary">Filtrovat</button>
        </form>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={params.q || status || queueOnly ? "Tomuto filtru neodpovídá žádná firma" : "Zatím tu nejsou žádné firmy"}
          description={
            params.q || status || queueOnly
              ? "Zkuste filtr uvolnit, nebo hledat jiný výraz."
              : "Firmy vznikají z importovaných kontaktů. Naimportujte kontakty a objeví se tady seskupené podle firmy."
          }
          action={{ href: "/contacts", label: "Importovat kontakty" }}
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Firma</th>
              <th className="th">Priorita</th>
              <th className="th">Proč ji řešíme</th>
              <th className="th">Stav</th>
              <th className="th">Hlavní kontakt</th>
              <th className="th">Poslední aktivita</th>
              <th className="th">Další krok</th>
              <th className="th">Odpovídá</th>
            </tr>
          }
        >
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-zinc-50">
              <td className="td">
                <Link href={`/firmy/${row.id}`} className="font-medium text-zinc-900 hover:underline">
                  {row.name}
                </Link>
                <div className="text-xs text-zinc-500">
                  {plural(row.contacts_count, "kontakt", "kontakty", "kontaktů")}
                  {row.in_queue ? <span className="ml-2 text-amber-700">ve frontě</span> : null}
                </div>
              </td>
              <td className="td"><PriorityBadge value={row.priority} /></td>
              <td className="td max-w-72">
                {row.reason ? (
                  <span className="line-clamp-2 text-sm text-zinc-700">{row.reason}</span>
                ) : (
                  <span className="text-zinc-400">zatím nevyplněno</span>
                )}
              </td>
              <td className="td"><CompanyStatusBadge value={row.status} /></td>
              <td className="td text-xs">
                <div className="text-zinc-900">{row.main_contact_name ?? row.main_contact_email ?? "—"}</div>
                {row.main_contact_phone ? <div className="text-zinc-500">{row.main_contact_phone}</div> : null}
              </td>
              <td className="td text-xs"><DateTime value={row.last_activity_at} fallback="—" /></td>
              <td className="td text-xs">
                {row.next_action_at ? (
                  <DateTime value={row.next_action_at} />
                ) : row.in_queue ? (
                  <span className="text-zinc-700">oslovit</span>
                ) : (
                  <span className="text-zinc-400">—</span>
                )}
              </td>
              <td className="td text-xs">{row.owner_name ?? <span className="text-zinc-400">—</span>}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
