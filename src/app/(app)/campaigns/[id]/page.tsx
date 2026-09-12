import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/lib/db";
import { checkCampaignReadiness } from "@/lib/queries/campaigns";
import { describeSenderPool, listActivity, listCampaignContacts, listCampaignStats } from "@/lib/queries/dashboard";
import {
  CALL_FILTER_LABELS,
  getCampaignCallingReport,
  listCallContacts,
  type CallFilter,
} from "@/lib/queries/calling";
import {
  MEETING_OUTCOME_LABELS,
  callOutcomeLabel,
  callStatusLabel,
  formatCzk,
  formatPercent,
  formatRatio,
} from "@/lib/calling";
import { formatSendDays, minutesToHHMM } from "@/lib/schedule";
import { PageHeader, Stat, StatusBadge, Table, DateTime } from "@/components/ui";
import { CampaignControls } from "@/components/campaign-controls";
import { SequenceEditor, type StepValues } from "@/components/sequence-editor";
import { Readiness } from "@/components/readiness";
import { ImportForm } from "@/components/import-form";
import { ContactRowActions } from "@/components/contact-row-actions";
import { CallingSettingsForm } from "@/components/calling-settings-form";
import { EconomicsForm } from "@/components/economics-form";
import type { Campaign } from "@/lib/types";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "prehled", label: "Přehled" },
  { key: "kontakty", label: "Kontakty" },
  { key: "sekvence", label: "Sekvence" },
  { key: "volani", label: "Volání" },
  { key: "ekonomika", label: "Ekonomika" },
  { key: "aktivita", label: "Aktivita" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; filter?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab, filter: rawFilter } = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === rawTab) ? (rawTab as Tab) : "prehled";

  const [campaign] = await sql<Campaign[]>`select * from campaigns where id = ${id}`;
  if (!campaign) notFound();

  const stats = (await listCampaignStats()).find((c) => c.id === id);
  const readonly = campaign.status === "active";

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={
          <>
            <StatusBadge status={campaign.status} />{" "}
            <span className="ml-2">
              {describeSenderPool(stats?.mailbox_names ?? [])} · {formatSendDays(campaign.send_days)}{" "}
              {minutesToHHMM(campaign.send_start_minute)}–{minutesToHHMM(campaign.send_end_minute)}{" "}
              {campaign.timezone} · limit {campaign.daily_limit}/den
              {campaign.calling_enabled ? " · volání zapnuto" : ""}
            </span>
          </>
        }
        actions={
          <>
            {campaign.calling_enabled ? (
              <Link href={`/volani/${id}`} className="btn-go">Volat</Link>
            ) : null}
            <Link href={`/campaigns/${id}/edit`} className="btn-secondary">Nastavení</Link>
            <CampaignControls id={id} status={campaign.status} />
          </>
        }
      />

      <div className="mb-6 flex flex-wrap gap-1 border-b border-zinc-200">
        {TABS.map((item) => (
          <Link
            key={item.key}
            href={`/campaigns/${id}?tab=${item.key}`}
            className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors ${
              tab === item.key
                ? "border-zinc-900 font-medium text-zinc-900"
                : "border-transparent text-zinc-500 hover:text-zinc-900"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>

      {tab === "prehled" ? <OverviewTab campaignId={id} stats={stats} /> : null}
      {tab === "kontakty" ? <ContactsTab campaignId={id} /> : null}
      {tab === "sekvence" ? <SequenceTab campaignId={id} readOnly={readonly} /> : null}
      {tab === "volani" ? <CallingTab campaign={campaign} filter={rawFilter} /> : null}
      {tab === "ekonomika" ? <EconomicsTab campaign={campaign} /> : null}
      {tab === "aktivita" ? <ActivityTab campaignId={id} /> : null}
    </>
  );
}

async function OverviewTab({
  campaignId,
  stats,
}: {
  campaignId: string;
  stats: Awaited<ReturnType<typeof listCampaignStats>>[number] | undefined;
}) {
  const readiness = await checkCampaignReadiness(campaignId);
  const replyRate = stats && stats.sent > 0 ? `${((stats.replies / stats.sent) * 100).toFixed(1)} %` : "—";

  return (
    <div className="space-y-6">
      <Readiness problems={readiness.problems} />

      <div className="card grid grid-cols-2 gap-6 p-6 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Kontakty" value={stats?.contacts ?? 0} />
        <Stat label="Odesláno" value={stats?.sent ?? 0} />
        <Stat label="Odpovědi" value={stats?.replies ?? 0} tone={stats?.replies ? "good" : undefined} />
        <Stat label="Míra odpovědí" value={replyRate} />
        <Stat label="Chyby" value={stats?.failed ?? 0} tone={stats?.failed ? "danger" : undefined} />
        <Stat label="Zbývá" value={stats?.remaining ?? 0} />
      </div>

      {stats && stats.needs_review > 0 ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>{stats.needs_review} odeslání s neznámým výsledkem.</strong> Worker byl přerušen
          uprostřed odesílání. Tyto e-maily se nikdy neopakují automaticky. Otevřete záložku Kontakty
          a krok buď přeskočte, nebo prospekt vyřešte ručně.
        </div>
      ) : null}
    </div>
  );
}

async function ContactsTab({ campaignId }: { campaignId: string }) {
  const contacts = await listCampaignContacts(campaignId);

  return (
    <div className="space-y-6">
      <ImportForm campaignId={campaignId} />

      {contacts.length === 0 ? (
        <p className="card px-6 py-10 text-center text-sm text-zinc-500">
          V této kampani zatím nejsou žádné kontakty.
        </p>
      ) : (
        <Table
          head={
            <tr>
              <th className="th">E-mail</th>
              <th className="th">Jméno</th>
              <th className="th">Firma</th>
              <th className="th">Stav</th>
              <th className="th text-right">Odesláno</th>
              <th className="th">Poslední e-mail</th>
              <th className="th">Další e-mail</th>
              <th className="th"></th>
            </tr>
          }
        >
          {contacts.map((contact) => (
            <tr key={contact.id} className="hover:bg-zinc-50">
              <td className="td font-medium text-zinc-900">
                <Link href={`/kontakt/${contact.id}`} className="hover:underline">{contact.email}</Link>
              </td>
              <td className="td">{contact.first_name ?? "—"}</td>
              <td className="td">{contact.company ?? "—"}</td>
              <td className="td">
                <StatusBadge status={contact.status} />
                {contact.last_error ? (
                  <div className="mt-1 max-w-xs text-xs text-red-600">{contact.last_error}</div>
                ) : null}
              </td>
              <td className="td text-right tabular-nums">{contact.sends}</td>
              <td className="td text-xs"><DateTime value={contact.last_sent_at} /></td>
              <td className="td text-xs"><DateTime value={contact.next_send_at} /></td>
              <td className="td">
                <ContactRowActions
                  campaignContactId={contact.id}
                  email={contact.email}
                  canResume={contact.status === "failed"}
                />
              </td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

async function SequenceTab({ campaignId, readOnly }: { campaignId: string; readOnly: boolean }) {
  const steps = await sql<(StepValues & { id: string })[]>`
    select s.step_number, s.delay_days, s.subject, s.body, s.id,
           exists (select 1 from email_sends es where es.step_id = s.id) as locked
      from sequence_steps s
     where s.campaign_id = ${campaignId}
     order by s.step_number
  `;
  return <SequenceEditor campaignId={campaignId} initialSteps={steps} readOnly={readOnly} />;
}

/**
 * The calling dashboard. Every KPI tile is a link that filters the contact
 * list below it, so "12 kvalifikovaných schůzek" is one click away from the
 * twelve prospects it means.
 */
async function CallingTab({ campaign, filter: rawFilter }: { campaign: Campaign; filter?: string }) {
  const filter: CallFilter = (Object.keys(CALL_FILTER_LABELS) as CallFilter[]).includes(rawFilter as CallFilter)
    ? (rawFilter as CallFilter)
    : "queue";

  const [report, contacts] = await Promise.all([
    getCampaignCallingReport(campaign.id),
    listCallContacts(campaign.id, filter),
  ]);

  const tile = (key: CallFilter, label: string, value: number, tone?: "good" | "danger") => (
    <Link key={key} href={`/campaigns/${campaign.id}?tab=volani&filter=${key}`} className="block rounded-md p-1 hover:bg-zinc-50">
      <Stat label={label} value={value} tone={tone} />
    </Link>
  );

  return (
    <div className="space-y-6">
      <div className="card grid grid-cols-2 gap-4 p-5 sm:grid-cols-4 lg:grid-cols-7">
        {tile("all", "Kontakty", report.counts.contacts)}
        {tile("queue", "Ve frontě", report.queue_size)}
        {tile("called", "Volané", report.counts.called)}
        {tile("connected", "Dovolané", report.counts.connected_contacts)}
        {tile("meetings_booked", "Schůzky", report.counts.meetings_booked, report.counts.meetings_booked ? "good" : undefined)}
        {tile("meetings_qualified", "Kvalifikované", report.counts.meetings_qualified, report.counts.meetings_qualified ? "good" : undefined)}
        {tile("won", "Klienti", report.counts.clients_won, report.counts.clients_won ? "good" : undefined)}
      </div>

      <div className="card grid grid-cols-2 gap-4 p-5 sm:grid-cols-4">
        <Stat label="Uskutečněné schůzky" value={report.counts.meetings_held} />
        <Stat
          label="Nedorazili"
          value={report.counts.meetings_no_show}
          tone={report.counts.meetings_no_show > 0 ? "danger" : undefined}
        />
        <Stat label="Nevolat (globálně)" value={report.do_not_call} />
        <Stat
          label="Bez telefonu"
          value={report.stranded}
          tone={report.stranded > 0 ? "danger" : undefined}
        />
      </div>

      {report.stranded > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{report.stranded} kontaktů nelze volat — chybí telefonní číslo.</strong> Nejsou ve
          frontě a nikdy se v ní neobjeví, takže v číslech výše vypadají jako nevyřízená práce.{" "}
          <Link href={`/campaigns/${campaign.id}?tab=volani&filter=no_phone`} className="underline">
            Zobrazit je
          </Link>
          .
        </div>
      ) : null}

      {report.meetings_unjudged > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{report.meetings_unjudged} schůzek zatím nemá posouzenou kvalifikaci.</strong>{" "}
          Kvalifikace rozhoduje o fakturaci — otevřete{" "}
          <Link href={`/campaigns/${campaign.id}?tab=volani&filter=meetings_booked`} className="underline">
            domluvené schůzky
          </Link>{" "}
          a posuďte je.
        </div>
      ) : null}

      <div className="card p-6">
        <h2 className="mb-4 text-sm font-semibold text-zinc-900">Trychtýř</h2>
        <div className="space-y-2">
          {report.funnel.map((stage) => {
            const top = report.funnel[0].value;
            const width = top > 0 ? Math.max(2, (stage.value / top) * 100) : 2;
            return (
              <div key={stage.key} className="flex items-center gap-3">
                <span className="w-48 shrink-0 text-sm text-zinc-600">{stage.label}</span>
                <div className="h-6 flex-1 overflow-hidden rounded bg-zinc-100">
                  <div className="h-full bg-zinc-900" style={{ width: `${width}%` }} />
                </div>
                <span className="w-16 shrink-0 text-right text-sm font-medium tabular-nums text-zinc-900">
                  {stage.value}
                </span>
                <span className="w-20 shrink-0 text-right text-xs tabular-nums text-zinc-500">
                  {stage.conversion === null ? "—" : formatPercent(stage.conversion)}
                </span>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Konverze je vždy vůči předchozímu kroku. Dovolané počítá kontakty, u kterých někdo skutečně
          mluvil s člověkem ({report.counts.connected_calls} dovolaných hovorů celkem).
        </p>
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(Object.keys(CALL_FILTER_LABELS) as CallFilter[]).map((key) => (
            <Link
              key={key}
              href={`/campaigns/${campaign.id}?tab=volani&filter=${key}`}
              className={`rounded-md px-3 py-1.5 text-sm ${
                filter === key
                  ? "bg-zinc-900 font-medium text-white"
                  : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {CALL_FILTER_LABELS[key]}
            </Link>
          ))}
        </div>

        {contacts.length === 0 ? (
          <p className="card px-6 py-10 text-center text-sm text-zinc-500">
            Žádný kontakt v této skupině.
          </p>
        ) : (
          <Table
            head={
              <tr>
                <th className="th">Kontakt</th>
                <th className="th">Telefon</th>
                <th className="th">Stav volání</th>
                <th className="th text-right">Pokusy</th>
                <th className="th">Poslední výsledek</th>
                <th className="th">Další akce</th>
                <th className="th">Schůzka</th>
                <th className="th">Caller</th>
              </tr>
            }
          >
            {contacts.map((row) => (
              <tr key={row.id} className="hover:bg-zinc-50">
                <td className="td">
                  <Link href={`/kontakt/${row.id}`} className="font-medium text-zinc-900 hover:underline">
                    {[row.first_name, row.last_name].filter(Boolean).join(" ") || row.email}
                  </Link>
                  <div className="text-xs text-zinc-500">{row.company ?? row.email}</div>
                </td>
                <td className="td text-xs">
                  {row.phone ? (
                    <a href={`tel:${row.phone.replace(/\s+/g, "")}`} className="text-zinc-900 hover:underline">
                      {row.phone}
                    </a>
                  ) : (
                    <span className="badge bg-amber-50 text-amber-700 ring-amber-200">chybí</span>
                  )}
                </td>
                <td className="td text-sm">{callStatusLabel(row.call_status)}</td>
                <td className="td text-right tabular-nums">{row.call_attempts}</td>
                <td className="td text-xs">{callOutcomeLabel(row.last_call_outcome)}</td>
                <td className="td text-xs"><DateTime value={row.next_call_at} /></td>
                <td className="td text-xs">
                  {row.meeting_booked ? (
                    <>
                      <DateTime value={row.meeting_at} />
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span
                          className={`badge ${
                            row.meeting_qualified === true
                              ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                              : row.meeting_qualified === false
                                ? "bg-zinc-50 text-zinc-500 ring-zinc-200"
                                : "bg-amber-50 text-amber-700 ring-amber-200"
                          }`}
                        >
                          {row.meeting_qualified === true
                            ? "kvalifikovaná"
                            : row.meeting_qualified === false
                              ? "nekvalifikovaná"
                              : "neposouzeno"}
                        </span>
                        {row.meeting_outcome !== "scheduled" ? (
                          <span
                            className={`badge ${
                              row.meeting_outcome === "held"
                                ? "bg-blue-50 text-blue-700 ring-blue-200"
                                : "bg-red-50 text-red-700 ring-red-200"
                            }`}
                          >
                            {MEETING_OUTCOME_LABELS[row.meeting_outcome]}
                          </span>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="td text-xs">{row.assigned_caller_name ?? "—"}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>

      <CallingSettingsForm
        values={{
          campaign_id: campaign.id,
          calling_enabled: campaign.calling_enabled,
          max_call_attempts: campaign.max_call_attempts,
          script_opening: campaign.script_opening ?? "",
          script_value: campaign.script_value ?? "",
          script_objections: campaign.script_objections ?? "",
          script_closing: campaign.script_closing ?? "",
          qualification_criteria: campaign.qualification_criteria ?? "",
        }}
      />
    </div>
  );
}

/** Did this campaign make money, and what did one meeting cost to produce. */
async function EconomicsTab({ campaign }: { campaign: Campaign }) {
  const report = await getCampaignCallingReport(campaign.id);
  const e = report.economics;

  return (
    <div className="space-y-6">
      <div className="card grid grid-cols-2 gap-6 p-6 sm:grid-cols-4">
        <Stat label="Příjem" value={formatCzk(e.revenue)} />
        <Stat label="Celkové náklady" value={formatCzk(e.total_cost)} />
        <Stat
          label="Hrubý zisk"
          value={formatCzk(e.gross_profit)}
          tone={e.gross_profit > 0 ? "good" : e.gross_profit < 0 ? "danger" : undefined}
        />
        <Stat label="Hrubá marže" value={formatPercent(e.gross_margin)} />
      </div>

      <div className="card p-6">
        <h2 className="mb-4 text-sm font-semibold text-zinc-900">Náklad na výsledek</h2>
        <dl className="grid grid-cols-2 gap-6 sm:grid-cols-4">
          <Stat label="Na dovolaný hovor" value={formatCzk(e.cost_per_connected_call)} />
          <Stat label="Na domluvenou schůzku" value={formatCzk(e.cost_per_booked_meeting)} />
          <Stat label="Na kvalifikovanou schůzku" value={formatCzk(e.cost_per_qualified_meeting)} />
          <Stat label="Na uskutečněnou schůzku" value={formatCzk(e.cost_per_held_meeting)} />
        </dl>
        <p className="mt-3 text-xs text-zinc-500">
          Náklad na callera {formatCzk(e.caller_cost)} + ostatní náklady{" "}
          {formatCzk(e.total_cost - e.caller_cost)} · {report.counts.connected_calls} dovolaných hovorů.
        </p>
      </div>

      <div className="card p-6">
        <h2 className="mb-1 text-sm font-semibold text-zinc-900">Akvizice klientů</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Čísla pro vlastní akvizici VEXY: kolik stálo získání klienta a kolik se vrátilo.
        </p>
        <dl className="grid grid-cols-2 gap-6 sm:grid-cols-5">
          <Stat label="Získaní klienti" value={e.clients_won} tone={e.clients_won ? "good" : undefined} />
          <Stat label="Příjem z obchodů" value={formatCzk(e.revenue_won)} />
          <Stat label="CAC" value={formatCzk(e.cac)} />
          <Stat label="ROAS" value={formatRatio(e.roas)} />
          <Stat label="Příjem na dovolaný hovor" value={formatCzk(e.revenue_per_connected_call)} />
        </dl>
      </div>

      <EconomicsForm
        values={{
          campaign_id: campaign.id,
          revenue_model: campaign.revenue_model,
          revenue_amount: campaign.revenue_amount,
          caller_cost_model: campaign.caller_cost_model,
          caller_cost_amount: campaign.caller_cost_amount,
          caller_hours: campaign.caller_hours,
          additional_costs: campaign.additional_costs,
        }}
      />
    </div>
  );
}

async function ActivityTab({ campaignId }: { campaignId: string }) {
  const rows = await listActivity({ campaignId, limit: 300 });
  if (rows.length === 0) {
    return <p className="card px-6 py-10 text-center text-sm text-zinc-500">Zatím se nic nestalo.</p>;
  }
  return (
    <Table
      head={
        <tr>
          <th className="th">Čas (UTC)</th>
          <th className="th">Kontakt</th>
          <th className="th">Akce</th>
          <th className="th">Detail</th>
        </tr>
      }
    >
      {rows.map((row) => (
        <tr key={row.id} className={row.level === "error" ? "bg-red-50/50" : undefined}>
          <td className="td whitespace-nowrap text-xs"><DateTime value={row.created_at} /></td>
          <td className="td text-xs">{row.contact_email ?? "—"}</td>
          <td className="td font-medium text-zinc-900">{row.action}</td>
          <td className="td text-xs text-zinc-600">{row.detail ?? "—"}</td>
        </tr>
      ))}
    </Table>
  );
}
