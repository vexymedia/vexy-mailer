import Link from "next/link";
import { sql } from "@/lib/db";
import { listMailboxes } from "@/lib/queries/mailboxes";
import { allMailboxCapacity } from "@/lib/engine/allocation";
import { PageHeader, Table, EmptyState, DateTime } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function MailboxesPage() {
  const [mailboxes, capacity, campaignCounts] = await Promise.all([
    listMailboxes(),
    allMailboxCapacity(sql),
    sql<{ mailbox_id: string; count: number }[]>`
      select cm.mailbox_id, count(*)::int as count
        from campaign_mailboxes cm
        join campaigns cp on cp.id = cm.campaign_id
       where cp.status = 'active'
       group by cm.mailbox_id
    `,
  ]);

  const usage = new Map(capacity.map((c) => [c.mailbox_id, c]));
  const activeCampaigns = new Map(campaignCounts.map((c) => [c.mailbox_id, c.count]));

  return (
    <>
      <PageHeader
        title="Schránky"
        description="Každá schránka má vlastní denní limit, který platí napříč všemi kampaněmi."
        actions={<Link href="/mailboxes/new" className="btn-primary">Přidat schránku</Link>}
      />

      {mailboxes.length === 0 ? (
        <EmptyState
          title="Zatím žádné schránky"
          description="Zadejte SMTP a IMAP údaje účtu, ze kterého chcete odesílat."
          action={{ href: "/mailboxes/new", label: "Přidat schránku" }}
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Schránka</th>
              <th className="th">SMTP</th>
              <th className="th">IMAP</th>
              <th className="th">Dnes odesláno</th>
              <th className="th text-right">Kampaně</th>
              <th className="th">Poslední odeslání</th>
              <th className="th">Poslední kontrola pošty</th>
            </tr>
          }
        >
          {mailboxes.map((mailbox) => {
            const used = usage.get(mailbox.id);
            const pct = used && used.daily_limit > 0 ? Math.min(100, (used.used_today / used.daily_limit) * 100) : 0;
            const full = used ? used.remaining === 0 : false;
            return (
              <tr key={mailbox.id} className="hover:bg-zinc-50">
                <td className="td">
                  <Link href={`/mailboxes/${mailbox.id}`} className="font-medium text-zinc-900 hover:underline">
                    {mailbox.from_email}
                  </Link>
                  <div className="text-xs text-zinc-500">
                    {mailbox.from_name} · {mailbox.name} · {mailbox.timezone}
                  </div>
                  {!mailbox.enabled ? (
                    <span className="badge mt-1 bg-orange-50 text-orange-700 ring-orange-200">vypnuto</span>
                  ) : null}
                </td>
                <td className="td">
                  {mailbox.last_test_ok === true ? (
                    <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">ok</span>
                  ) : mailbox.last_test_ok === false ? (
                    <span className="badge bg-red-50 text-red-700 ring-red-200">chyba</span>
                  ) : (
                    <span className="badge bg-zinc-50 text-zinc-600 ring-zinc-200">neotestováno</span>
                  )}
                  <div className="mt-1 text-xs text-zinc-500">{mailbox.smtp_host}:{mailbox.smtp_port}</div>
                </td>
                <td className="td">
                  {mailbox.imap_host ? (
                    mailbox.imap_last_error ? (
                      <span className="badge bg-red-50 text-red-700 ring-red-200">chyba</span>
                    ) : (
                      <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">nastaveno</span>
                    )
                  ) : (
                    <span className="badge bg-amber-50 text-amber-700 ring-amber-200">chybí</span>
                  )}
                  {mailbox.imap_last_error ? (
                    <div className="mt-1 max-w-48 text-xs text-red-600">{mailbox.imap_last_error}</div>
                  ) : null}
                </td>
                <td className="td w-44">
                  <div className={`text-sm tabular-nums ${full ? "font-semibold text-red-600" : "text-zinc-900"}`}>
                    {used?.used_today ?? 0} / {mailbox.daily_limit}
                  </div>
                  <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-zinc-200">
                    <div
                      className={`h-full ${full ? "bg-red-500" : "bg-zinc-900"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </td>
                <td className="td text-right tabular-nums">{activeCampaigns.get(mailbox.id) ?? 0}</td>
                <td className="td text-xs"><DateTime value={mailbox.last_send_at} fallback="nikdy" /></td>
                <td className="td text-xs"><DateTime value={mailbox.imap_last_checked_at} fallback="nikdy" /></td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
