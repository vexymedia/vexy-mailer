import Link from "next/link";
import { sql } from "@/lib/db";
import { getInboxCounts, listConversations, type InboxFilters } from "@/lib/queries/inbox";
import { PageHeader, Table, EmptyState, DateTime } from "@/components/ui";
import { ClassificationBadge } from "@/components/inbox-bits";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "positive", label: "Positive" },
  { key: "needs_action", label: "Needs action" },
] as const;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; campaign?: string; mailbox?: string; q?: string }>;
}) {
  const params = await searchParams;
  const filter = (FILTERS.find((f) => f.key === params.filter)?.key ?? "all") as InboxFilters["filter"];

  const [conversations, counts, campaigns, mailboxes] = await Promise.all([
    listConversations({
      filter,
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
    const merged = { filter: params.filter, campaign: params.campaign, mailbox: params.mailbox, q: params.q, ...overrides };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    const qs = next.toString();
    return qs ? `/inbox?${qs}` : "/inbox";
  };

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Replies from every mailbox, in one place."
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const count = counts[f.key];
          return (
            <Link
              key={f.key}
              href={query({ filter: f.key === "all" ? undefined : f.key })}
              className={`rounded-md px-3 py-1.5 text-sm ${
                active ? "bg-zinc-900 font-medium text-white" : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
              }`}
            >
              {f.label}
              <span className={`ml-1.5 tabular-nums ${active ? "text-zinc-300" : "text-zinc-400"}`}>{count}</span>
            </Link>
          );
        })}

        <form className="ml-auto flex flex-wrap items-center gap-2">
          {params.filter ? <input type="hidden" name="filter" value={params.filter} /> : null}
          <select name="campaign" defaultValue={params.campaign ?? ""} className="input w-auto py-1.5 text-sm">
            <option value="">All campaigns</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select name="mailbox" defaultValue={params.mailbox ?? ""} className="input w-auto py-1.5 text-sm">
            <option value="">All mailboxes</option>
            {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.from_email}</option>)}
          </select>
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Search contact or company…"
            className="input w-auto py-1.5 text-sm"
          />
          <button type="submit" className="btn-secondary">Filter</button>
        </form>
      </div>

      {conversations.length === 0 ? (
        <EmptyState
          title="No replies yet"
          description="When a prospect answers, the conversation appears here — whichever mailbox they wrote to."
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Contact</th>
              <th className="th">Company</th>
              <th className="th">Campaign</th>
              <th className="th">Sent from → replied to</th>
              <th className="th">Subject</th>
              <th className="th">Status</th>
              <th className="th">Last message</th>
            </tr>
          }
        >
          {conversations.map((c) => (
            <tr key={c.id} className={c.unread_count > 0 ? "bg-blue-50/40 hover:bg-blue-50" : "hover:bg-zinc-50"}>
              <td className="td">
                <Link href={`/inbox/${c.id}`} className="font-medium text-zinc-900 hover:underline">
                  {c.contact_name?.trim() || c.contact_email}
                </Link>
                <div className="text-xs text-zinc-500">{c.contact_email}</div>
                {c.unread_count > 0 ? (
                  <span className="badge mt-1 bg-blue-50 text-blue-700 ring-blue-200">
                    {c.unread_count} unread
                  </span>
                ) : null}
              </td>
              <td className="td">{c.company ?? "—"}</td>
              <td className="td text-xs">{c.campaign_name ?? "—"}</td>
              <td className="td text-xs">
                <div className="text-zinc-900">{c.mailbox_email}</div>
                {c.replied_to_email && c.replied_to_email !== c.mailbox_email ? (
                  <div className="text-zinc-500">→ {c.replied_to_email}</div>
                ) : null}
              </td>
              <td className="td max-w-64 truncate text-xs">{c.subject ?? "—"}</td>
              <td className="td"><ClassificationBadge value={c.classification} /></td>
              <td className="td text-xs"><DateTime value={c.last_message_at} /></td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
