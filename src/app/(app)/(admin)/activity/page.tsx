import { listActivity } from "@/lib/queries/dashboard";
import { PageHeader, Table, DateTime } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const rows = await listActivity({ limit: 500 });

  return (
    <>
      <PageHeader title="Aktivita" description="Posledních 500 událostí napříč všemi kampaněmi." />
      {rows.length === 0 ? (
        <p className="card px-6 py-10 text-center text-sm text-zinc-500">Zatím se nic nestalo.</p>
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Čas (UTC)</th>
              <th className="th">Kampaň</th>
              <th className="th">Kontakt</th>
              <th className="th">Akce</th>
              <th className="th">Detail</th>
            </tr>
          }
        >
          {rows.map((row) => (
            <tr key={row.id} className={row.level === "error" ? "bg-red-50/50" : undefined}>
              <td className="td whitespace-nowrap text-xs"><DateTime value={row.created_at} /></td>
              <td className="td text-xs">{row.campaign_name ?? "—"}</td>
              <td className="td text-xs">{row.contact_email ?? "—"}</td>
              <td className="td font-medium text-zinc-900">{row.action}</td>
              <td className="td text-xs text-zinc-600">{row.detail ?? "—"}</td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
