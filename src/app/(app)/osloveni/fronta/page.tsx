import Link from "next/link";
import { listCallQueue } from "@/lib/queries/calling";
import { callOutcomeLabel, callStatusLabel } from "@/lib/calling";
import { PageHeader, Table, EmptyState, DateTime } from "@/components/ui";
import { OsloveniTabs } from "@/components/osloveni-tabs";

export const dynamic = "force-dynamic";

/**
 * Celá fronta v pořadí, v jakém se bude zpracovávat. Čte se jen - rezervaci
 * bere až "Dnes", když si o kontakt někdo řekne.
 */
export default async function FrontaPage() {
  const queue = await listCallQueue(null, { limit: 200 });

  return (
    <>
      <PageHeader
        title="Fronta"
        description="Kdo čeká na oslovení, v pořadí, v jakém na ně dojde řada."
        actions={<Link href="/osloveni" className="btn-go">Začít zpracovávat</Link>}
      />
      <OsloveniTabs active="/osloveni/fronta" />

      {queue.length === 0 ? (
        <EmptyState
          title="Fronta je prázdná"
          description="Nikdo nečeká: buď jsou všichni vyřízení, vyčerpali pokusy, nemají telefon, nebo mají follow-up naplánovaný na později."
          action={{ href: "/firmy", label: "Projít firmy" }}
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Firma</th>
              <th className="th">Kontakt</th>
              <th className="th">Telefon</th>
              <th className="th">Stav</th>
              <th className="th text-right">Pokusy</th>
              <th className="th">Poslední výsledek</th>
              <th className="th">Další krok</th>
              <th className="th">Kampaň</th>
            </tr>
          }
        >
          {queue.map((row) => (
            <tr key={row.id} className="hover:bg-zinc-50">
              <td className="td">
                {row.company_id ? (
                  <Link href={`/firmy/${row.company_id}`} className="font-medium text-zinc-900 hover:underline">
                    {row.company ?? "—"}
                  </Link>
                ) : (
                  <span className="font-medium text-zinc-900">{row.company ?? "—"}</span>
                )}
              </td>
              <td className="td">
                <Link href={`/kontakt/${row.id}`} className="text-zinc-900 hover:underline">
                  {[row.first_name, row.last_name].filter(Boolean).join(" ") || row.email}
                </Link>
                <div className="text-xs text-zinc-500">{row.email}</div>
              </td>
              <td className="td text-xs">
                {row.phone ? (
                  <a href={`tel:${row.phone.replace(/\s+/g, "")}`} className="text-zinc-900 hover:underline">
                    {row.phone}
                  </a>
                ) : (
                  <span className="text-zinc-400">—</span>
                )}
              </td>
              <td className="td text-sm">{callStatusLabel(row.call_status)}</td>
              <td className="td text-right tabular-nums">{row.call_attempts}</td>
              <td className="td text-xs">{callOutcomeLabel(row.last_call_outcome)}</td>
              <td className="td text-xs"><DateTime value={row.next_call_at} fallback="hned" /></td>
              <td className="td text-xs text-zinc-500">{row.campaign_name}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
