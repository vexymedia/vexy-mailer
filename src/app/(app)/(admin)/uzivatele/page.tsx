import { listUsers } from "@/lib/queries/users";
import { listCallers } from "@/lib/queries/calling";
import { currentUser } from "@/lib/auth";
import { toggleUserAction } from "@/lib/actions";
import { PageHeader, Table, DateTime, EmptyState } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { AddUserToggle, PasswordForm } from "@/components/user-form";
import { NastaveniTabs } from "@/components/section-tabs";

export const dynamic = "force-dynamic";

/**
 * Uživatelé, tedy kdo se může přihlásit.
 *
 * Vedle toho existuje Tým - obchodní identity, na které se zapisují
 * hovory. Nejsou to duplicity: do týmu patří i lidé, kteří do aplikace
 * nechodí, a naopak administrátor žádnou obchodní identitu nemá.
 */
export default async function UsersPage() {
  const [users, callers, me] = await Promise.all([listUsers(), listCallers(), currentUser()]);

  const taken = new Set(users.map((u) => u.caller_id).filter(Boolean) as string[]);
  const options = callers.map((caller) => ({
    id: caller.id,
    name: caller.active ? caller.name : `${caller.name} (neaktivní)`,
    taken: taken.has(caller.id),
  }));

  return (
    <>
      <PageHeader
        title="Uživatelé"
        description="Kdo se může přihlásit."
      />
      <NastaveniTabs active="/uzivatele" />

      {/* Přidávání až pod záložkami: rozbalené v hlavičce by formulář
          odstrčil navigaci a tabulka by zmizela pod přehyb. */}
      <div className="mb-5 flex justify-end">
        <AddUserToggle callers={options} />
      </div>

      {users.length === 0 ? (
        <EmptyState
          title="Zatím tu není žádný uživatel"
          description="Přidejte prvního — bez přihlášení se do VEXY nikdo nedostane."
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Jméno</th>
              <th className="th">E-mail</th>
              <th className="th">Role</th>
              <th className="th">Obchodní identita</th>
              <th className="th">Stav</th>
              <th className="th">Přidán</th>
              <th className="th"></th>
            </tr>
          }
        >
          {users.map((user) => (
            <tr key={user.id} className="hover:bg-zinc-50">
              <td className="td font-medium text-zinc-900">
                {user.name}
                {user.id === me?.id ? (
                  <span className="ml-2 text-xs font-normal text-zinc-400">to jste vy</span>
                ) : null}
              </td>
              <td className="td text-xs text-zinc-600">{user.email}</td>
              <td className="td">
                <span
                  className={`badge ${
                    user.role === "admin"
                      ? "bg-zinc-900 text-white ring-zinc-900"
                      : "bg-zinc-100 text-zinc-700 ring-zinc-200"
                  }`}
                >
                  {user.role === "admin" ? "Administrátor" : "Caller"}
                </span>
              </td>
              <td className="td text-sm text-zinc-600">{user.caller_name ?? "—"}</td>
              <td className="td">
                {user.is_active ? (
                  <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">aktivní</span>
                ) : (
                  <span className="badge bg-zinc-50 text-zinc-500 ring-zinc-200">deaktivovaný</span>
                )}
              </td>
              <td className="td text-xs"><DateTime value={user.created_at} /></td>
              <td className="td">
                <div className="flex flex-wrap items-start justify-end gap-2">
                  <PasswordForm userId={user.id} name={user.name} />
                  {user.id === me?.id ? null : (
                    <ActionForm action={toggleUserAction} hideMessages>
                      <input type="hidden" name="user_id" value={user.id} />
                      <input type="hidden" name="active" value={user.is_active ? "no" : "yes"} />
                      <SubmitButton className="btn-secondary !px-2 !py-1 text-xs">
                        {user.is_active ? "Deaktivovat" : "Aktivovat"}
                      </SubmitButton>
                    </ActionForm>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
