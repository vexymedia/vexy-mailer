import Link from "next/link";
import { sql } from "@/lib/db";
import { listMailboxes } from "@/lib/queries/mailboxes";
import { allMailboxCapacity } from "@/lib/engine/allocation";
import { listMailboxHealth, mailboxProblem } from "@/lib/queries/deliverability";
import { PageHeader, Table, EmptyState, DateTime } from "@/components/ui";
import { NastaveniTabs } from "@/components/section-tabs";

export const dynamic = "force-dynamic";

export default async function MailboxesPage() {
  const [mailboxes, capacity, health, campaignCounts] = await Promise.all([
    listMailboxes(),
    allMailboxCapacity(sql),
    listMailboxHealth(),
    sql<{ mailbox_id: string; count: number }[]>`
      select cm.mailbox_id, count(*)::int as count
        from campaign_mailboxes cm
        join campaigns cp on cp.id = cm.campaign_id
       where cp.status = 'active'
       group by cm.mailbox_id
    `,
  ]);

  const usage = new Map(capacity.map((c) => [c.mailbox_id, c]));
  const healthById = new Map(health.map((h) => [h.mailbox_id, h]));
  const problems = health
    .map((h) => ({ mailbox: h, problem: mailboxProblem(h) }))
    .filter((p): p is { mailbox: (typeof health)[number]; problem: string } => p.problem !== null);
  const activeCampaigns = new Map(campaignCounts.map((c) => [c.mailbox_id, c.count]));

  return (
    <>
      <PageHeader
        title="Schránky"
        actions={<Link href="/mailboxes/new" className="btn-primary">Přidat schránku</Link>}
      />
      <NastaveniTabs active={"/mailboxes"} />

      {/* Problémy nahoru. Sloupec s čísly je k ničemu, když člověk musí
          sám poznat, že tři reputation bloky jsou víc než nula. */}
      {problems.length > 0 ? (
        <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">
            {problems.length === 1 ? "1 schránka vyžaduje pozornost" : `${problems.length} schránek vyžaduje pozornost`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {problems.map((p) => (
              <li key={p.mailbox.mailbox_id} className="text-sm text-amber-900">
                <Link href={`/mailboxes/${p.mailbox.mailbox_id}`} className="font-medium underline underline-offset-2">
                  {p.mailbox.from_email}
                </Link>{" "}
                — {p.problem}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
              <th className="th" title="Za posledních 7 dní">Nedoručeno (7 dní)</th>
              <th className="th text-right">Kampaně</th>
              <th className="th">Poslední odeslání</th>
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
                <td className="td text-xs">
                  {(() => {
                    const h = healthById.get(mailbox.id);
                    if (!h) return <span className="text-zinc-400">—</span>;
                    if (h.hard_invalid + h.temporary + h.reputation_blocks === 0) {
                      return <span className="text-zinc-400">bez chyb</span>;
                    }
                    return (
                      <span className="space-x-2 tabular-nums">
                        {h.hard_invalid > 0 ? (
                          <span className="text-red-600" title="Adresa neexistuje">
                            {h.hard_invalid} neexistuje
                          </span>
                        ) : null}
                        {h.temporary > 0 ? (
                          <span className="text-zinc-600" title="Dočasná chyba doručení">
                            {h.temporary} dočasně
                          </span>
                        ) : null}
                        {h.reputation_blocks > 0 ? (
                          <span className="font-medium text-amber-700" title="Reputace nebo politika serveru">
                            {h.reputation_blocks} reputace
                          </span>
                        ) : null}
                      </span>
                    );
                  })()}
                </td>
                <td className="td text-right tabular-nums">{activeCampaigns.get(mailbox.id) ?? 0}</td>
                <td className="td text-xs"><DateTime value={mailbox.last_send_at} fallback="nikdy" /></td>
              </tr>
            );
          })}
        </Table>
      )}
    </>
  );
}
