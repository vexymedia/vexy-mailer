import { listContactOverview } from "@/lib/queries/contacts";
import { PageHeader, StatusBadge, Table, DateTime } from "@/components/ui";
import { ImportForm } from "@/components/import-form";
import { SuppressButton } from "@/components/suppress-button";

export const dynamic = "force-dynamic";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { q, page } = await searchParams;
  const pageNumber = Math.max(1, Number(page ?? 1) || 1);
  const limit = 100;
  const { rows, total } = await listContactOverview({
    search: q,
    limit,
    offset: (pageNumber - 1) * limit,
  });
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <>
      <PageHeader title="Contacts" description={`${total} row(s). A contact appears once per campaign it belongs to.`} />

      <div className="mb-6 space-y-4">
        <ImportForm />
        <form className="flex gap-2">
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search email, name or company…"
            className="input max-w-sm"
          />
          <button type="submit" className="btn-secondary">Search</button>
        </form>
      </div>

      {rows.length === 0 ? (
        <p className="card px-6 py-10 text-center text-sm text-zinc-500">
          {q ? "No contacts match that search." : "No contacts yet — import a CSV above."}
        </p>
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Email</th>
              <th className="th">Name</th>
              <th className="th">Company</th>
              <th className="th">Campaign</th>
              <th className="th">Status</th>
              <th className="th">Last email sent</th>
              <th className="th">Next email</th>
              <th className="th">Replied</th>
              <th className="th"></th>
            </tr>
          }
        >
          {rows.map((row) => (
            <tr key={`${row.id}-${row.campaign_id ?? "none"}`} className="hover:bg-zinc-50">
              <td className="td font-medium text-zinc-900">
                {row.email}
                {row.suppressed ? (
                  <span className="badge ml-2 bg-orange-50 text-orange-700 ring-orange-200">
                    do not contact
                  </span>
                ) : null}
              </td>
              <td className="td">{[row.first_name, row.last_name].filter(Boolean).join(" ") || "—"}</td>
              <td className="td">{row.company ?? "—"}</td>
              <td className="td">{row.campaign_name ?? <span className="text-zinc-400">—</span>}</td>
              <td className="td"><StatusBadge status={row.status} /></td>
              <td className="td text-xs"><DateTime value={row.last_sent_at} /></td>
              <td className="td text-xs"><DateTime value={row.next_send_at} /></td>
              <td className="td">
                {row.replied ? <span className="font-medium text-emerald-600">yes</span> : "—"}
              </td>
              <td className="td text-right">
                {row.suppressed ? null : <SuppressButton email={row.email} />}
              </td>
            </tr>
          ))}
        </Table>
      )}

      {pages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm text-zinc-600">
          <span>Page {pageNumber} of {pages}</span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <a className="btn-secondary" href={`/contacts?page=${pageNumber - 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>
                Previous
              </a>
            ) : null}
            {pageNumber < pages ? (
              <a className="btn-secondary" href={`/contacts?page=${pageNumber + 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>
                Next
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
