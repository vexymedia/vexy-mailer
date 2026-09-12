import { listCallersWithTotals } from "@/lib/queries/calling";
import { saveCallerAction, toggleCallerAction } from "@/lib/actions";
import { PageHeader, Table, DateTime } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";

export const dynamic = "force-dynamic";

/**
 * Callers are a first-class record, not a name typed onto a prospect: one
 * caller works across campaigns and one campaign is worked by several callers.
 * This screen is deliberately just add and retire - everything else about a
 * caller is future scope.
 */
export default async function CallersPage() {
  const callers = await listCallersWithTotals();

  return (
    <>
      <PageHeader
        title="Calleři"
        description="Kdo volá. Caller se nemaže, jen deaktivuje — historie hovorů a ekonomika kampaní se na něj odkazují."
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
            <SubmitButton pendingLabel="Ukládám…">Přidat callera</SubmitButton>
          </div>
        </ActionForm>
      </div>

      {callers.length === 0 ? (
        <p className="card px-6 py-10 text-center text-sm text-zinc-500">Zatím není zadaný žádný caller.</p>
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Caller</th>
              <th className="th">Kontakt</th>
              <th className="th">Stav</th>
              <th className="th text-right">Dovolané hovory</th>
              <th className="th text-right">Domluvené schůzky</th>
              <th className="th">Přidán</th>
              <th className="th"></th>
            </tr>
          }
        >
          {callers.map((caller) => (
            <tr key={caller.id} className="hover:bg-zinc-50">
              <td className="td font-medium text-zinc-900">{caller.name}</td>
              <td className="td text-xs text-zinc-600">
                {caller.email ?? "—"}
                {caller.phone ? <div>{caller.phone}</div> : null}
              </td>
              <td className="td">
                {caller.active ? (
                  <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">aktivní</span>
                ) : (
                  <span className="badge bg-zinc-50 text-zinc-500 ring-zinc-200">neaktivní</span>
                )}
              </td>
              <td className="td text-right tabular-nums">{caller.connected_calls}</td>
              <td className="td text-right tabular-nums">{caller.meetings_booked}</td>
              <td className="td text-xs"><DateTime value={caller.created_at} /></td>
              <td className="td text-right">
                <ActionForm action={toggleCallerAction} hideMessages>
                  <input type="hidden" name="id" value={caller.id} />
                  <input type="hidden" name="active" value={caller.active ? "no" : "yes"} />
                  <SubmitButton className="btn-secondary !px-2 !py-1 text-xs">
                    {caller.active ? "Deaktivovat" : "Aktivovat"}
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
