import { sql } from "../db";
import { logActivity } from "../activity";
import { hashPassword } from "../password";
import { normaliseEmail, isValidEmail } from "../csv";

/**
 * Přihlašovací účty.
 *
 * `callers` zůstává obchodní identitou, na kterou se váže reporting;
 * tady je jen přihlášení a role. Vazba je `users.caller_id`.
 */

export type UserRole = "admin" | "caller";

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  caller_id: string | null;
  is_active: boolean;
  created_at: Date;
}

export interface UserRow extends User {
  /** Jméno obchodní identity, když nějakou má. */
  caller_name: string | null;
}

/** Řádek pro přihlášení. Hash se nikdy nedostane nikam dál. */
interface UserWithHash extends User {
  password_hash: string;
}

export type UserWriteError =
  | "duplicate"
  | "invalid_email"
  | "weak_password"
  | "caller_required"
  | "caller_taken"
  | "not_found"
  | "last_admin";

export type UserWriteResult = { ok: true; id: string } | { ok: false; error: UserWriteError };

const COLUMNS = sql`id, email, name, role, caller_id, is_active, created_at`;

export async function listUsers(): Promise<UserRow[]> {
  return sql<UserRow[]>`
    select u.id, u.email, u.name, u.role, u.caller_id, u.is_active, u.created_at,
           c.name as caller_name
      from users u
      left join callers c on c.id = u.caller_id
     order by u.is_active desc, u.role, u.name
  `;
}

export async function getUser(id: string): Promise<User | null> {
  const [row] = await sql<User[]>`select ${COLUMNS} from users where id = ${id}`;
  return row ?? null;
}

/**
 * Účet pro přihlášení, včetně hashe.
 *
 * Vrací i deaktivované účty - o tom, že se deaktivovaný člověk nepřihlásí,
 * rozhoduje přihlašovací cesta, ne tenhle dotaz. Kdyby filtroval sám,
 * nešlo by rozlišit „neexistuje“ od „je vypnutý“ ani v logu.
 */
export function findUserForLogin(email: string) {
  return sql<UserWithHash[]>`
    select ${COLUMNS}, password_hash from users where lower(email) = ${normaliseEmail(email)}
  `;
}

/**
 * Nedokončený dotaz vrací zvlášť, protože se musí dát ZRUŠIT.
 *
 * postgres.js po navázání spojení dotazu žádný strop nedává. Když se
 * odpovědi nedočká, `await` se dá přerušit v aplikaci - jenže spojení tím
 * zůstane obsazené a při `max: 1` se za něj zařadí každý další dotaz
 * v téhle instanci. Z jednoho zadrhnutého přihlášení se tak stane
 * instance, na které přihlášení nefunguje už nikdy.
 *
 * `Query.cancel()` je jediné, co tomu brání: pošle databázi CancelRequest
 * a spojení se vrátí do poolu použitelné. Viz `withQueryTimeout`.
 */
export async function getUserForLogin(email: string): Promise<UserWithHash | null> {
  const [row] = await findUserForLogin(email);
  return row ?? null;
}

export async function countActiveAdmins(): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from users where role = 'admin' and is_active
  `;
  return row?.count ?? 0;
}

export interface UserInput {
  email: string;
  name: string;
  role: UserRole;
  /** Povinné u role caller, ignoruje se u admina. */
  callerId?: string | null;
  password: string;
}

/** Společná kontrola vstupu. Stejná pro založení i pro úpravu. */
async function validate(
  input: Omit<UserInput, "password">,
  excludeUserId: string | null,
): Promise<
  { ok: true; email: string; callerId: string | null } | { ok: false; error: UserWriteError }
> {
  const email = normaliseEmail(input.email ?? "");
  if (!email || !isValidEmail(email)) return { ok: false, error: "invalid_email" };

  const [clash] = await sql<{ id: string }[]>`
    select id from users
     where lower(email) = ${email}
       and (${excludeUserId}::uuid is null or id <> ${excludeUserId}::uuid)
  `;
  if (clash) return { ok: false, error: "duplicate" };

  // Admin obchodní identitu nemá; caller bez ní nemá kam zapsat hovory.
  if (input.role === "admin") return { ok: true, email, callerId: null };

  const callerId = input.callerId ?? null;
  if (!callerId) return { ok: false, error: "caller_required" };

  const [caller] = await sql<{ id: string }[]>`
    select id from callers where id = ${callerId}
  `;
  if (!caller) return { ok: false, error: "caller_required" };

  const [taken] = await sql<{ id: string }[]>`
    select id from users
     where caller_id = ${callerId}
       and (${excludeUserId}::uuid is null or id <> ${excludeUserId}::uuid)
  `;
  if (taken) return { ok: false, error: "caller_taken" };

  return { ok: true, email, callerId };
}

export async function createUser(input: UserInput): Promise<UserWriteResult> {
  const checked = await validate(input, null);
  if (!checked.ok) return { ok: false, error: checked.error };

  const [row] = await sql<{ id: string }[]>`
    insert into users (email, name, role, caller_id, password_hash)
    values (${checked.email}, ${input.name.trim() || checked.email}, ${input.role},
            ${checked.callerId}, ${await hashPassword(input.password)})
    returning id
  `;
  await logActivity({ action: "Uživatel přidán", detail: `${checked.email} · ${input.role}` });
  return { ok: true, id: row.id };
}

/** Úprava bez hesla. Heslo se mění vlastní akcí, aby se nedalo přepsat omylem. */
export async function updateUser(
  id: string,
  input: Omit<UserInput, "password">,
): Promise<UserWriteResult> {
  const current = await getUser(id);
  if (!current) return { ok: false, error: "not_found" };

  const checked = await validate(input, id);
  if (!checked.ok) return { ok: false, error: checked.error };

  // Poslední aktivní admin nesmí přestat být adminem: jinak se do
  // nastavení nedostane nikdo a účty nemá kdo spravovat.
  if (current.role === "admin" && input.role !== "admin" && current.is_active) {
    if ((await countActiveAdmins()) <= 1) return { ok: false, error: "last_admin" };
  }

  await sql`
    update users
       set email = ${checked.email},
           name = ${input.name.trim() || checked.email},
           role = ${input.role},
           caller_id = ${checked.callerId},
           updated_at = now()
     where id = ${id}
  `;
  await logActivity({ action: "Uživatel upraven", detail: checked.email });
  return { ok: true, id };
}

export async function setUserPassword(id: string, password: string): Promise<UserWriteResult> {
  const user = await getUser(id);
  if (!user) return { ok: false, error: "not_found" };

  await sql`
    update users set password_hash = ${await hashPassword(password)}, updated_at = now()
     where id = ${id}
  `;
  await logActivity({ action: "Heslo změněno", detail: user.email });
  return { ok: true, id };
}

/**
 * Zapne nebo vypne účet.
 *
 * Deaktivace je to, co nahrazuje mazání: hovory a výsledky se na
 * uživatele odkazují a musí zůstat čitelné.
 */
export async function setUserActive(id: string, active: boolean): Promise<UserWriteResult> {
  const user = await getUser(id);
  if (!user) return { ok: false, error: "not_found" };

  if (!active && user.role === "admin" && user.is_active) {
    if ((await countActiveAdmins()) <= 1) return { ok: false, error: "last_admin" };
  }

  await sql`update users set is_active = ${active}, updated_at = now() where id = ${id}`;
  await logActivity({
    action: active ? "Uživatel aktivován" : "Uživatel deaktivován",
    detail: user.email,
  });
  return { ok: true, id };
}
