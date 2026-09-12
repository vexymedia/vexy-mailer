import { sql } from "@/lib/db";
import { unsuppressEmailAction, suppressEmailAction } from "@/lib/actions";
import { PageHeader, Table, DateTime } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";

export const dynamic = "force-dynamic";

interface SuppressionRow {
  id: string;
  email: string;
  reason: string;
  note: string | null;
  created_at: Date;
}

export default async function SuppressionPage() {
  const rows = await sql<SuppressionRow[]>`
    select id, email, reason, note, created_at from suppression_list order by created_at desc
  `;

  return (
    <>
      <PageHeader
        title="Nekontaktovat"
        description="Globální blokační seznam. Tyto adresy se odstraní ze všech kampaní a databáze je do žádné nové nepustí."
      />

      <div className="mb-6 max-w-xl">
        <ActionForm action={suppressEmailAction} className="card p-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <label className="label" htmlFor="email">Přidat adresu</label>
              <input id="email" name="email" type="email" required className="input" placeholder="someone@company.com" />
            </div>
            <input type="hidden" name="reason" value="manual" />
            <SubmitButton pendingLabel="Přidávám…">Přidat</SubmitButton>
          </div>
        </ActionForm>
      </div>

      {rows.length === 0 ? (
        <p className="card px-6 py-10 text-center text-sm text-zinc-500">Seznam je prázdný.</p>
      ) : (
        <Table
          head={
            <tr>
              <th className="th">E-mail</th>
              <th className="th">Důvod</th>
              <th className="th">Přidáno</th>
              <th className="th"></th>
            </tr>
          }
        >
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="td font-medium text-zinc-900">{row.email}</td>
              <td className="td">
                {row.reason}
                {row.note ? <div className="text-xs text-zinc-500">{row.note}</div> : null}
              </td>
              <td className="td text-xs"><DateTime value={row.created_at} /></td>
              <td className="td text-right">
                <ActionForm action={unsuppressEmailAction} hideMessages>
                  <input type="hidden" name="email" value={row.email} />
                  <SubmitButton
                    className="btn-secondary !px-2 !py-1 text-xs"
                    confirm={`Odebrat ${row.email} ze seznamu Nekontaktovat? Adresa půjde znovu kontaktovat.`}
                  >
                    Odebrat
                  </SubmitButton>
                </ActionForm>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
