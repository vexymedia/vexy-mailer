import Link from "next/link";
import { sql } from "@/lib/db";
import { listConversations } from "@/lib/queries/inbox";
import { PageHeader, EmptyState, DateTime } from "@/components/ui";
import { KomunikaceTabs } from "@/components/section-tabs";

export const dynamic = "force-dynamic";

/**
 * Schránka: e-mailová konverzace, ne triage odpovědí.
 *
 * Rozdíl proti Odpovědím je jediný a zásadní - tady jsou vidět i vlákna,
 * kde jsme zatím jen odeslali. Redesign nechal v aplikaci jen seznam
 * reakcí, takže odeslaná pošta nebyla nikde a Schránka se jevila jako
 * ztracená funkce. Backend přitom celou dobu existoval; chyběl pohled.
 */

const DIRECTIONS = [
  { key: "all", label: "Vše" },
  { key: "incoming", label: "Příchozí" },
  { key: "outgoing", label: "Jen odeslané" },
  { key: "unread", label: "Nepřečtené" },
] as const;

type Direction = (typeof DIRECTIONS)[number]["key"];

export default async function MailboxPage({
  searchParams,
}: {
  searchParams: Promise<{ mailbox?: string; smer?: string; q?: string }>;
}) {
  const params = await searchParams;
  const direction = (DIRECTIONS.find((d) => d.key === params.smer)?.key ?? "all") as Direction;

  const [threads, mailboxes] = await Promise.all([
    listConversations({
      scope: "all",
      filter: direction === "unread" ? "unread" : "all",
      mailboxId: params.mailbox || null,
      search: params.q || null,
    }),
    sql<{ id: string; from_email: string; name: string; enabled: boolean }[]>`
      select id, from_email, name, enabled from mailboxes order by from_email
    `,
  ]);

  // Příchozí / jen odeslané se filtruje tady: dotaz vrací obojí a rozdíl
  // je jediný boolean, takže druhý průchod databází nemá co přinést.
  const visible = threads.filter((thread) =>
    direction === "incoming" ? thread.has_inbound
    : direction === "outgoing" ? !thread.has_inbound
    : true,
  );

  const query = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { mailbox: params.mailbox, smer: params.smer, q: params.q, ...overrides };
    for (const [key, value] of Object.entries(merged)) if (value) next.set(key, value);
    const qs = next.toString();
    return qs ? `/inbox/schranka?${qs}` : "/inbox/schranka";
  };

  const unread = visible.reduce((sum, thread) => sum + thread.unread_count, 0);
  const activeMailbox = mailboxes.find((m) => m.id === params.mailbox) ?? null;

  return (
    <>
      <PageHeader
        title="Schránka"
        description="Celá e-mailová konverzace — odeslané i příchozí. Odpovídá se ze schránky, ze které se psalo."
        actions={
          <Link href="/mailboxes" className="btn-secondary">
            Spravovat schránky
          </Link>
        }
      />
      <KomunikaceTabs active="/inbox/schranka" />

      {/* ------------------------------------------------ výběr schránky */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link
          href={query({ mailbox: undefined })}
          className={`rounded-md px-3 py-1.5 text-sm ${
            !params.mailbox
              ? "bg-zinc-900 font-medium text-white"
              : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
          }`}
        >
          Všechny schránky
        </Link>
        {mailboxes.map((mailbox) => (
          <Link
            key={mailbox.id}
            href={query({ mailbox: mailbox.id })}
            className={`rounded-md px-3 py-1.5 text-sm ${
              params.mailbox === mailbox.id
                ? "bg-zinc-900 font-medium text-white"
                : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
            }`}
          >
            {mailbox.from_email}
            {!mailbox.enabled ? (
              <span className="ml-1.5 text-xs text-amber-600">vypnutá</span>
            ) : null}
          </Link>
        ))}
      </div>

      {/* --------------------------------------------- směr a vyhledávání */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {DIRECTIONS.map((item) => (
          <Link
            key={item.key}
            href={query({ smer: item.key === "all" ? undefined : item.key })}
            className={`rounded-md px-3 py-1.5 text-sm ${
              direction === item.key
                ? "bg-zinc-100 font-medium text-zinc-900 ring-1 ring-inset ring-zinc-300"
                : "text-zinc-600 hover:bg-zinc-50"
            }`}
          >
            {item.label}
          </Link>
        ))}

        <form className="ml-auto flex items-center gap-2">
          {params.mailbox ? <input type="hidden" name="mailbox" value={params.mailbox} /> : null}
          {params.smer ? <input type="hidden" name="smer" value={params.smer} /> : null}
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Hledat kontakt nebo firmu…"
            className="input w-full py-1.5 text-sm sm:w-64"
          />
          <button type="submit" className="btn-secondary !py-1.5 text-sm">Hledat</button>
        </form>
      </div>

      <p className="mb-3 text-sm text-zinc-500">
        {visible.length === 0 ? "Žádná vlákna" : `${visible.length} vláken`}
        {unread > 0 ? ` · ${unread} nepřečtených` : ""}
        {activeMailbox ? ` · ${activeMailbox.name}` : ""}
      </p>

      {visible.length === 0 ? (
        <EmptyState
          title="Tady zatím nic není"
          description="Jakmile se z některé schránky odešle e-mail nebo přijde odpověď, objeví se vlákno tady."
          action={{ href: "/campaigns", label: "Kampaně" }}
        />
      ) : (
        <ul className="card divide-y divide-zinc-100">
          {visible.map((thread) => {
            const unreadThread = thread.unread_count > 0;
            return (
              <li key={thread.id}>
                <Link
                  href={`/inbox/${thread.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-3 hover:bg-zinc-50"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        className={`truncate text-sm ${
                          unreadThread ? "font-semibold text-zinc-900" : "font-medium text-zinc-800"
                        }`}
                      >
                        {thread.contact_name?.trim() || thread.contact_email}
                      </span>
                      {thread.company ? (
                        <span className="truncate text-xs text-zinc-500">{thread.company}</span>
                      ) : null}
                      {unreadThread ? (
                        <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">
                          nepřečteno
                        </span>
                      ) : null}
                      {!thread.has_inbound ? (
                        <span className="badge bg-zinc-50 text-zinc-500 ring-zinc-200">
                          zatím bez odpovědi
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate text-sm text-zinc-600">
                      {thread.subject ?? "(bez předmětu)"}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-zinc-500">
                    <span className="block"><DateTime value={thread.last_message_at} /></span>
                    <span className="block">
                      {thread.message_count} {thread.message_count === 1 ? "zpráva" : "zpráv"} ·{" "}
                      {thread.mailbox_email}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
