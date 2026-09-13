import Link from "next/link";
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
      <PageHeader
        title="Všechny kontakty"
        description={`${total} řádků. Kontakt je člověk uvnitř firmy — rozhodujeme se o firmě.`}
        actions={<Link href="/firmy" className="btn-secondary">Zobrazit po firmách</Link>}
      />

      <div className="mb-6 space-y-4">
        <ImportForm />
        <form className="flex gap-2">
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="Hledat e-mail, jméno nebo firmu…"
            className="input max-w-sm"
          />
          <button type="submit" className="btn-secondary">Hledat</button>
        </form>
      </div>

      {rows.length === 0 ? (
        <p className="card px-6 py-10 text-center text-sm text-zinc-500">
          {q ? "Tomuto hledání neodpovídá žádný kontakt." : "Zatím žádné kontakty — nahrajte CSV výše."}
        </p>
      ) : (
        <Table
          head={
            <tr>
              <th className="th">E-mail</th>
              <th className="th">Jméno</th>
              <th className="th">Firma</th>
              <th className="th">Telefon</th>
              <th className="th">Kampaň</th>
              <th className="th">Stav</th>
              <th className="th">Poslední e-mail</th>
              <th className="th">Další e-mail</th>
              <th className="th">Odpověď</th>
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
                    nekontaktovat
                  </span>
                ) : null}
              </td>
              <td className="td">{[row.first_name, row.last_name].filter(Boolean).join(" ") || "—"}</td>
              <td className="td">{row.company ?? "—"}</td>
              <td className="td text-xs">
                {row.phone ? (
                  <a href={`tel:${row.phone.replace(/\s+/g, "")}`} className="text-zinc-900 hover:underline">
                    {row.phone}
                  </a>
                ) : (
                  <span className="text-zinc-400">—</span>
                )}
              </td>
              <td className="td">{row.campaign_name ?? <span className="text-zinc-400">—</span>}</td>
              <td className="td"><StatusBadge status={row.status} /></td>
              <td className="td text-xs"><DateTime value={row.last_sent_at} /></td>
              <td className="td text-xs"><DateTime value={row.next_send_at} /></td>
              <td className="td">
                {row.replied ? <span className="font-medium text-emerald-600">ano</span> : "—"}
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
          <span>Strana {pageNumber} z {pages}</span>
          <div className="flex gap-2">
            {pageNumber > 1 ? (
              <a className="btn-secondary" href={`/contacts?page=${pageNumber - 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>
                Předchozí
              </a>
            ) : null}
            {pageNumber < pages ? (
              <a className="btn-secondary" href={`/contacts?page=${pageNumber + 1}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>
                Další
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
