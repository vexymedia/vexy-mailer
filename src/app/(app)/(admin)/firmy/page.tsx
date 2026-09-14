import Link from "next/link";
import { listCompanies, type ActivityFilter, type CompanyRow, type NextActionFilter } from "@/lib/queries/companies";
import { COMPANY_STATUS_LABELS, type CompanyPriority, type CompanyStatus } from "@/lib/companies";
import { formatWhen, isOverdue } from "@/lib/datetime";
import { plural } from "@/lib/plan";
import { listCallers } from "@/lib/queries/calling";
import { CompanyCreateForm } from "@/components/company-create-form";
import {
  PageHeader,
  Table,
  EmptyState,
  DateTime,
  PriorityBadge,
  CompanyStatusBadge,
} from "@/components/ui";

export const dynamic = "force-dynamic";

type Params = {
  q?: string;
  status?: string;
  priority?: string;
  owner?: string;
  fronta?: string;
  krok?: string;
  aktivita?: string;
  pokusy?: string;
  schuzky?: string;
};

/**
 * Seznam firem jako pracovní seznam, ne databázová tabulka.
 *
 * Z jednoho řádku musí jít poznat: co je to za firmu, proč ji řešíme, co se
 * s ní dělo a co bude dál. Rychlé pohledy nahoře jsou jen předvyplněné
 * filtry - žádný saved-view engine.
 */
export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const status = (params.status && params.status in COMPANY_STATUS_LABELS ? params.status : null) as CompanyStatus | null;
  const priority = (["high", "normal", "low"].includes(params.priority ?? "") ? params.priority : null) as CompanyPriority | null;
  const nextAction = (["due", "today", "none"].includes(params.krok ?? "") ? params.krok : null) as NextActionFilter | null;
  const activity = (["7d", "30d", "stale", "never"].includes(params.aktivita ?? "") ? params.aktivita : null) as ActivityFilter | null;
  const minAttempts = params.pokusy && /^\d+$/.test(params.pokusy) ? Number(params.pokusy) : null;
  const meetingsOnly = params.schuzky === "1";
  const queueOnly = params.fronta === "1";

  const [{ rows, total }, team] = await Promise.all([
    listCompanies({
      search: params.q ?? null,
      status,
      priority,
      ownerId: params.owner || null,
      queueOnly,
      nextAction,
      activity,
      minAttempts,
      meetingsOnly,
    }),
    listCallers(),
  ]);

  const link = (overrides: Partial<Record<keyof Params, string | undefined>>) => {
    const next = new URLSearchParams();
    const merged = { ...params, ...overrides } as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    const qs = next.toString();
    return qs ? `/firmy?${qs}` : "/firmy";
  };

  // Rychlý pohled = kombinace filtrů, kterou člověk opravdu denně používá.
  const blank: Partial<Record<keyof Params, undefined>> = {
    status: undefined,
    priority: undefined,
    fronta: undefined,
    krok: undefined,
    aktivita: undefined,
    pokusy: undefined,
    schuzky: undefined,
  };
  const views = [
    { label: "Vše", href: link(blank), active: !nextAction && !priority && !minAttempts && !meetingsOnly && !queueOnly && !status },
    { label: "Dnes řešit", href: link({ ...blank, krok: "due" }), active: nextAction === "due" },
    { label: "Follow-up dnes", href: link({ ...blank, krok: "today" }), active: nextAction === "today" },
    { label: "Bez dalšího kroku", href: link({ ...blank, krok: "none" }), active: nextAction === "none" },
    { label: "High priority", href: link({ ...blank, priority: "high" }), active: priority === "high" && !nextAction },
    { label: "3+ pokusy", href: link({ ...blank, pokusy: "3" }), active: minAttempts === 3 },
    { label: "Schůzky", href: link({ ...blank, schuzky: "1" }), active: meetingsOnly },
  ];

  const filtered =
    Boolean(params.q) || Boolean(status) || Boolean(priority) || Boolean(nextAction) ||
    Boolean(activity) || minAttempts !== null || meetingsOnly || queueOnly;

  return (
    <>
      <PageHeader
        title="Firmy"
        description={`${plural(total, "firma", "firmy", "firem")}. Kontakt je člověk uvnitř firmy — rozhodujeme se o firmě.`}
        actions={<CompanyCreateForm />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {views.map((view) => (
          <Link key={view.label} href={view.href} className={`chip ${view.active ? "chip-active" : ""}`}>
            {view.label}
          </Link>
        ))}
      </div>

      <form className="mb-5 flex flex-wrap items-center gap-2">
        <input
          name="q"
          defaultValue={params.q ?? ""}
          placeholder="Hledat firmu, důvod nebo kontakt…"
          className="input w-full py-1.5 text-sm sm:w-64"
        />
        <select name="status" defaultValue={params.status ?? ""} className="input w-auto py-1.5 text-sm">
          <option value="">Stav: vše</option>
          {(Object.keys(COMPANY_STATUS_LABELS) as CompanyStatus[]).map((key) => (
            <option key={key} value={key}>{COMPANY_STATUS_LABELS[key]}</option>
          ))}
        </select>
        <select name="priority" defaultValue={params.priority ?? ""} className="input w-auto py-1.5 text-sm">
          <option value="">Priorita: vše</option>
          <option value="high">Vysoká</option>
          <option value="normal">Běžná</option>
          <option value="low">Nízká</option>
        </select>
        <select name="owner" defaultValue={params.owner ?? ""} className="input w-auto py-1.5 text-sm">
          <option value="">Odpovídá: kdokoliv</option>
          {team.map((member) => (
            <option key={member.id} value={member.id}>{member.name}</option>
          ))}
        </select>
        <select name="krok" defaultValue={params.krok ?? ""} className="input w-auto py-1.5 text-sm">
          <option value="">Další krok: vše</option>
          <option value="due">Splatný dnes a dřív</option>
          <option value="today">Jen dnes</option>
          <option value="none">Bez dalšího kroku</option>
        </select>
        <select name="aktivita" defaultValue={params.aktivita ?? ""} className="input w-auto py-1.5 text-sm">
          <option value="">Aktivita: vše</option>
          <option value="7d">Posledních 7 dní</option>
          <option value="30d">Posledních 30 dní</option>
          <option value="stale">Déle než 14 dní ticho</option>
          <option value="never">Nikdy jsme nekontaktovali</option>
        </select>
        <button type="submit" className="btn-secondary">Filtrovat</button>
      </form>

      {rows.length === 0 ? (
        <EmptyState
          title={filtered ? "Tomuto filtru neodpovídá žádná firma" : "Zatím tu nejsou žádné firmy"}
          description={
            filtered
              ? "Zkuste filtr uvolnit, nebo hledat jiný výraz."
              : "Firmy vznikají z importovaných kontaktů. Naimportujte kontakty a objeví se tady seskupené podle firmy."
          }
          action={{ href: "/contacts", label: "Importovat kontakty" }}
        />
      ) : (
        <>
          {/* Desktop: jedna firma = jeden řádek. */}
          <div className="hidden md:block">
            <Table
              head={
                <tr>
                  <th className="th">Firma a proč ji řešíme</th>
                  <th className="th">Stav</th>
                  <th className="th">Hlavní kontakt</th>
                  <th className="th">Pokusy</th>
                  <th className="th">Poslední aktivita</th>
                  <th className="th">Další krok</th>
                  <th className="th">Odpovídá</th>
                </tr>
              }
            >
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-zinc-50">
                  <td className="td max-w-80">
                    <div className="flex items-center gap-2">
                      <Link href={`/firmy/${row.id}`} className="font-medium text-zinc-900 hover:underline">
                        {row.name}
                      </Link>
                      <PriorityBadge value={row.priority} />
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-600">
                      {row.reason ? (
                        <span className="line-clamp-2">{row.reason}</span>
                      ) : (
                        <span className="text-zinc-400">důvod zatím nevyplněn</span>
                      )}
                    </div>
                  </td>
                  <td className="td"><CompanyStatusBadge value={row.status} /></td>
                  <td className="td text-xs">
                    <div className="text-zinc-900">{row.main_contact_name ?? row.main_contact_email ?? "—"}</div>
                    {row.main_contact_phone ? <div className="tabular-nums text-zinc-500">{row.main_contact_phone}</div> : null}
                  </td>
                  <td className="td text-sm tabular-nums text-zinc-700">{row.attempts}</td>
                  <td className="td text-xs"><DateTime value={row.last_activity_at} fallback="—" /></td>
                  <td className="td text-xs"><NextStepCell row={row} /></td>
                  <td className="td text-xs">{row.owner_name ?? <span className="text-zinc-400">—</span>}</td>
                </tr>
              ))}
            </Table>
          </div>

          {/* Mobil: karty. Devět sloupců se na 400 px nevejde a scrollovat
              tabulku do strany je horší práce než scrollovat karty dolů. */}
          <ul className="space-y-2 md:hidden">
            {rows.map((row) => (
              <li key={row.id} className="card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/firmy/${row.id}`} className="font-medium text-zinc-900">
                    {row.name}
                  </Link>
                  <PriorityBadge value={row.priority} />
                  <CompanyStatusBadge value={row.status} />
                </div>
                {row.reason ? (
                  <p className="mt-1 line-clamp-2 text-xs text-zinc-600">{row.reason}</p>
                ) : null}
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <div>
                    <dt className="text-zinc-500">Hlavní kontakt</dt>
                    <dd className="text-zinc-900">{row.main_contact_name ?? row.main_contact_email ?? "—"}</dd>
                    {row.main_contact_phone ? (
                      <dd className="tabular-nums text-zinc-600">{row.main_contact_phone}</dd>
                    ) : null}
                  </div>
                  <div>
                    <dt className="text-zinc-500">Další krok</dt>
                    <dd><NextStepCell row={row} /></dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Pokusy</dt>
                    <dd className="tabular-nums text-zinc-900">{row.attempts}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-500">Poslední aktivita</dt>
                    <dd className="text-zinc-900"><DateTime value={row.last_activity_at} fallback="—" /></dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** Další krok tak, aby se z něj dalo rozhodnout bez otevření detailu. */
function NextStepCell({ row }: { row: CompanyRow }) {
  if (row.next_action_at) {
    return (
      <span className={isOverdue(row.next_action_at) ? "font-medium text-red-600" : "text-zinc-900"}>
        {formatWhen(row.next_action_at)}
      </span>
    );
  }
  if (row.needs_attention) {
    return <span className="font-medium text-amber-700">Bez dalšího kroku</span>;
  }
  if (row.in_queue) return <span className="text-zinc-700">Oslovit</span>;
  return <span className="text-zinc-400">—</span>;
}
