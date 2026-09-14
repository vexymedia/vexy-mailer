import Link from "next/link";
import { sql } from "@/lib/db";
import {
  INBOX_VIEWS,
  getInboxCounts,
  listConversations,
  type InboxView,
} from "@/lib/queries/inbox";
import { PageHeader, EmptyState, DateTime } from "@/components/ui";
import { ClassificationBadge } from "@/components/inbox-bits";
import { KomunikaceTabs } from "@/components/section-tabs";

export const dynamic = "force-dynamic";

/**
 * Action inbox.
 *
 * Výchozí pohled je "K vyřízení", ne "Vše". Původní obrazovka ukazovala
 * všechna vlákna včetně těch, kde jsme jen něco odeslali a nikdo
 * neodpověděl - tedy seznam, který se nedá projít a nemá žádnou akci.
 * Odeslaná pošta nezmizela: je v záložce Schránka, v detailu kontaktu
 * i firmy a v historii kampaně.
 *
 * Řádek je jedna položka práce, ne buňky tabulky: člověk, firma, o čem
 * to je a kdy to přišlo. Sedm sloupců se v šířce obrazovky rozpadalo na
 * useknuté předměty a nešlo v nich nic najít.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; campaign?: string; mailbox?: string; q?: string }>;
}) {
  const params = await searchParams;
  const view = (INBOX_VIEWS.find((v) => v.key === params.view)?.key ?? "todo") as InboxView;

  const [conversations, counts, campaigns, mailboxes] = await Promise.all([
    listConversations({
      view,
      campaignId: params.campaign || null,
      mailboxId: params.mailbox || null,
      search: params.q || null,
    }),
    getInboxCounts(),
    sql<{ id: string; name: string }[]>`select id, name from campaigns order by name`,
    sql<{ id: string; from_email: string }[]>`select id, from_email from mailboxes order by from_email`,
  ]);

  const query = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { view: params.view, campaign: params.campaign, mailbox: params.mailbox, q: params.q, ...overrides };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    const qs = next.toString();
    return qs ? `/inbox?${qs}` : "/inbox";
  };

  return (
    <>
      <PageHeader title="Odpovědi" />
      <KomunikaceTabs active={"/inbox"} />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {INBOX_VIEWS.map((v) => {
          const active = view === v.key;
          const count = counts[v.key];
          return (
            <Link
              key={v.key}
              href={query({ view: v.key === "todo" ? undefined : v.key })}
              className={`rounded-md px-3 py-1.5 text-sm ${
                active
                  ? "bg-zinc-900 font-medium text-white"
                  : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {v.label}
              <span className={`ml-1.5 tabular-nums ${active ? "text-zinc-300" : "text-zinc-400"}`}>
                {count}
              </span>
            </Link>
          );
        })}

        <form className="ml-auto flex flex-wrap items-center gap-2">
          {params.view ? <input type="hidden" name="view" value={params.view} /> : null}
          <select name="campaign" defaultValue={params.campaign ?? ""} className="input w-auto py-1.5 text-sm">
            <option value="">Všechny kampaně</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select name="mailbox" defaultValue={params.mailbox ?? ""} className="input w-auto py-1.5 text-sm">
            <option value="">Všechny schránky</option>
            {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.from_email}</option>)}
          </select>
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Hledat kontakt nebo firmu…"
            className="input w-auto py-1.5 text-sm"
          />
          <button type="submit" className="btn-secondary">Filtrovat</button>
        </form>
      </div>

      {conversations.length === 0 ? (
        <EmptyState
          title={view === "todo" ? "Nic k vyřízení" : "Žádné konverzace"}
          description={
            view === "todo"
              ? "Všechny odpovědi jsou zařazené. Nové se objeví tady."
              : "V tomhle pohledu zatím nic není."
          }
        />
      ) : (
        <ul className="card divide-y divide-zinc-100">
          {conversations.map((c) => (
            <li key={c.id}>
              <Link
                href={`/inbox/${c.id}`}
                className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 hover:bg-zinc-50 ${
                  c.unread_count > 0 ? "bg-blue-50/40" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-zinc-900">
                      {c.contact_name?.trim() || c.contact_email}
                    </span>
                    {c.company ? <span className="text-sm text-zinc-600">· {c.company}</span> : null}
                    {c.unread_count > 0 ? (
                      <span className="badge bg-blue-50 text-blue-700 ring-blue-200">nové</span>
                    ) : null}
                    {/* V "K vyřízení" je nezařazeno každý řádek - odznak by
                        jen opakoval název záložky. */}
                    {view === "todo" ? null : <ClassificationBadge value={c.classification} />}
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-zinc-600">
                    {c.subject ?? c.contact_email}
                  </span>
                  <span className="mt-0.5 block text-xs text-zinc-500">
                    {c.campaign_name ?? "bez kampaně"} · {c.mailbox_email}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                  <DateTime value={c.last_inbound_at ?? c.last_message_at} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
