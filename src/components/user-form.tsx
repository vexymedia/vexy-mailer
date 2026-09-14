"use client";

import { useState } from "react";
import { saveUserAction, setUserPasswordAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import { MIN_PASSWORD_LENGTH } from "@/lib/password-rules";

/**
 * Založení a úprava uživatele.
 *
 * Formulář se řídí rolí: administrátor obchodní identitu nemá, takže se
 * pole vůbec nezobrazí. Callerovi se naopak nabídne, protože bez ní by
 * jeho hovory neměly komu patřit.
 */

export interface CallerOption {
  id: string;
  name: string;
  /** Už má přihlášení? Pak se nedá přiřadit podruhé. */
  taken: boolean;
}

export function UserForm({
  callers,
  user,
  onDone,
}: {
  callers: CallerOption[];
  /** Vyplněné = úprava, prázdné = nový uživatel. */
  user?: {
    id: string;
    name: string;
    email: string;
    role: "admin" | "caller";
    callerId: string | null;
  };
  onDone?: () => void;
}) {
  const [role, setRole] = useState<"admin" | "caller">(user?.role ?? "caller");
  const editing = Boolean(user);
  // Při úpravě zůstává vlastní identita v nabídce, i když je „obsazená“ -
  // obsadil ji tenhle uživatel.
  const available = callers.filter((c) => !c.taken || c.id === user?.callerId);

  return (
    <ActionForm action={saveUserAction} className="card p-5">
      {user ? <input type="hidden" name="user_id" value={user.id} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="user_name">Jméno</label>
          <input
            id="user_name"
            name="name"
            required
            defaultValue={user?.name ?? ""}
            placeholder="Jan Novák"
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="user_email">E-mail</label>
          <input
            id="user_email"
            name="email"
            type="email"
            required
            defaultValue={user?.email ?? ""}
            placeholder="jan@example.com"
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor="user_role">Role</label>
          <select
            id="user_role"
            name="role"
            value={role}
            onChange={(event) => setRole(event.target.value as "admin" | "caller")}
            className="input"
          >
            <option value="caller">Caller</option>
            <option value="admin">Administrátor</option>
          </select>
        </div>

        {role === "caller" ? (
          <div>
            <label className="label" htmlFor="user_caller">Obchodní identita</label>
            <select id="user_caller" name="caller_id" required defaultValue={user?.callerId ?? ""} className="input">
              <option value="">— vyberte —</option>
              {available.map((caller) => (
                <option key={caller.id} value={caller.id}>{caller.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-zinc-500">
              Pod touhle identitou se zapisují hovory a výsledky.
            </p>
          </div>
        ) : null}

        {!editing ? (
          <div className={role === "caller" ? "sm:col-span-2" : ""}>
            <label className="label" htmlFor="user_password">Heslo</label>
            <input
              id="user_password"
              name="password"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              className="input"
            />
            <p className="mt-1 text-xs text-zinc-500">
              Aspoň {MIN_PASSWORD_LENGTH} znaků. Předejte ho uživateli bezpečnou cestou.
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <SubmitButton pendingLabel="Ukládám…">
          {editing ? "Uložit změny" : "Přidat uživatele"}
        </SubmitButton>
        {onDone ? (
          <button type="button" onClick={onDone} className="btn-secondary">Zrušit</button>
        ) : null}
      </div>

      {role === "caller" && available.length === 0 ? (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Všechny obchodní identity už mají přihlášení. Nejdřív přidejte člověka do týmu.
        </p>
      ) : null}
    </ActionForm>
  );
}

/** Změna hesla. Rozbalí se u konkrétního člověka, ne jako další stránka. */
export function PasswordForm({ userId, name }: { userId: string; name: string }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary !px-2 !py-1 text-xs">
        Změnit heslo
      </button>
    );
  }

  return (
    <ActionForm action={setUserPasswordAction} className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-3">
      <input type="hidden" name="user_id" value={userId} />
      <label className="label" htmlFor={`pw_${userId}`}>Nové heslo pro {name}</label>
      <input
        id={`pw_${userId}`}
        name="password"
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        autoComplete="new-password"
        className="input"
      />
      <div className="mt-2 flex items-center gap-2">
        <SubmitButton className="btn-primary !px-2 !py-1 text-xs" pendingLabel="Ukládám…">
          Nastavit heslo
        </SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className="btn-secondary !px-2 !py-1 text-xs">
          Zrušit
        </button>
      </div>
    </ActionForm>
  );
}

/** Přidávání se rozbalí až na vyžádání, ať tabulka zůstane hlavní věcí. */
export function AddUserToggle({ callers }: { callers: CallerOption[] }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-primary">
        Přidat uživatele
      </button>
    );
  }
  return (
    <div className="w-full">
      <UserForm callers={callers} onDone={() => setOpen(false)} />
    </div>
  );
}
