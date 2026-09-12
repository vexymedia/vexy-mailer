import { listCallersWithTotals } from "@/lib/queries/calling";
import { saveCallerAction, toggleCallerAction } from "@/lib/actions";
import { PageHeader, Table, DateTime, EmptyState } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";

export const dynamic = "force-dynamic";

/**
 * Tým. Lidé, kteří zpracovávají oslovení — obchodník, asistent, caller
 * i externí call centrum. Není to HR systém ani systém oprávnění: drží se
 * tu jen to, co potřebuje fronta a plán, tedy kdo existuje a kdo je aktivní.
 */
export default async function TeamPage() {
  const team = await listCallersWithTotals();

  return (
    <>
      <PageHeader
        title="Tým"
        description="Kdo zpracovává oslovení. Člověk se nemaže, jen deaktivuje — historie a výsledky se na něj odkazují."
      />

      <div className="mb-6 max-w-2xl">
        <ActionForm action={saveCallerAction} className="card p-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="name">Jméno</label>
              <input id="name" name="name" required className="input" placeholder="Jan Novák" />
            </div>
            <div>
              <label className="label" htmlFor="email">E-mail (nepovinné)</label>
              <input id="email" name="email" type="email" className="input" />
            </div>
            <div>
              <label className="label" htmlFor="phone">Telefon (nepovinné)</label>
              <input id="phone" name="phone" className="input" />
            </div>
          </div>
          <div className="mt-4">
            <SubmitButton pendingLabel="Ukládám…">Přidat do týmu</SubmitButton>
          </div>
        </ActionForm>
      </div>

      {team.length === 0 ? (
        <EmptyState
          title="V týmu zatím nikdo není"
          description="Oslovení se zapisuje na konkrétního člověka a podle něj se plánuje kapacita. Přidejte prvního výše."
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Jméno</th>
              <th className="th">Kontakt</th>
              <th className="th">Stav</th>
              <th className="th text-right">Dovolané hovory</th>
              <th className="th text-right">Domluvené schůzky</th>
              <th className="th">Přidán</th>
              <th className="th"></th>
            </tr>
          }
        >
          {team.map((member) => (
            <tr key={member.id} className="hover:bg-zinc-50">
              <td className="td font-medium text-zinc-900">{member.name}</td>
              <td className="td text-xs text-zinc-600">
                {member.email ?? "—"}
                {member.phone ? <div>{member.phone}</div> : null}
              </td>
              <td className="td">
                {member.active ? (
                  <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">aktivní</span>
                ) : (
                  <span className="badge bg-zinc-50 text-zinc-500 ring-zinc-200">neaktivní</span>
                )}
              </td>
              <td className="td text-right tabular-nums">{member.connected_calls}</td>
              <td className="td text-right tabular-nums">{member.meetings_booked}</td>
              <td className="td text-xs"><DateTime value={member.created_at} /></td>
              <td className="td text-right">
                <ActionForm action={toggleCallerAction} hideMessages>
                  <input type="hidden" name="id" value={member.id} />
                  <input type="hidden" name="active" value={member.active ? "no" : "yes"} />
                  <SubmitButton className="btn-secondary !px-2 !py-1 text-xs">
                    {member.active ? "Deaktivovat" : "Aktivovat"}
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
