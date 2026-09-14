import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode } from "./helpers/fixtures";

/**
 * Přihlášení a oprávnění.
 *
 * Tyhle testy existují kvůli jediné otázce: může externí caller dostat
 * přístup k něčemu, co mu nepatří? Netestuje se tedy, jestli se skryje
 * položka v menu - to je UX - ale jestli server odmítne.
 */

let sql: typeof import("@/lib/db").sql;
let users: typeof import("@/lib/queries/users");
let password: typeof import("@/lib/password");
let auth: typeof import("@/lib/auth");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  users = await import("@/lib/queries/users");
  password = await import("@/lib/password");
  auth = await import("@/lib/auth");
});

afterAll(async () => {
  await closeDatabase();
});

const STRONG = "dost-dlouhe-heslo";

async function seedAdmin(email = "vojta@vexy.cz") {
  const result = await users.createUser({
    email,
    name: "Vojta",
    role: "admin",
    password: STRONG,
  });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}

async function seedCaller(name = "Jan Novák", email = "jan@example.com") {
  const calling = await import("@/lib/queries/calling");
  const callerId = await calling.createCaller({ name, email: null, phone: null });
  const result = await users.createUser({
    email,
    name,
    role: "caller",
    callerId,
    password: STRONG,
  });
  if (!result.ok) throw new Error(result.error);
  return { userId: result.id, callerId };
}

describe("hashování hesla", () => {
  it("neukládá heslo v čitelné podobě a ověří ho", async () => {
    const hash = await password.hashPassword(STRONG);
    expect(hash).not.toContain(STRONG);
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await password.verifyPassword(STRONG, hash)).toBe(true);
    expect(await password.verifyPassword("neco-jineho", hash)).toBe(false);
  });

  it("dvakrát stejné heslo dá jiný hash", async () => {
    // Jinak by se z databáze poznalo, kdo má stejné heslo jako kdo.
    expect(await password.hashPassword(STRONG)).not.toBe(await password.hashPassword(STRONG));
  });

  it("poškozený hash je neplatné heslo, ne výjimka", async () => {
    for (const broken of ["", "nesmysl", "scrypt$x$y$z$a$b", "bcrypt$1$2$3$4$5"]) {
      expect(await password.verifyPassword(STRONG, broken)).toBe(false);
    }
  });

  it("krátké heslo se odmítne", () => {
    expect(password.passwordProblem("kratke")).not.toBeNull();
    expect(password.passwordProblem(STRONG)).toBeNull();
  });
});

describe("přihlášení", () => {
  it("projde správnému adminovi i callerovi", async () => {
    await seedAdmin();
    await seedCaller();

    for (const email of ["vojta@vexy.cz", "jan@example.com"]) {
      const user = await users.getUserForLogin(email);
      expect(user).not.toBeNull();
      expect(await password.verifyPassword(STRONG, user!.password_hash)).toBe(true);
    }
  });

  it("neprojde se špatným heslem", async () => {
    await seedAdmin();
    const user = await users.getUserForLogin("vojta@vexy.cz");
    expect(await password.verifyPassword("spatne-heslo-tady", user!.password_hash)).toBe(false);
  });

  it("neznámý účet neexistuje", async () => {
    expect(await users.getUserForLogin("nikdo@example.com")).toBeNull();
  });

  it("e-mail nerozlišuje velikost písmen", async () => {
    await seedAdmin();
    expect(await users.getUserForLogin("VOJTA@VEXY.CZ")).not.toBeNull();
    // A stejný e-mail nejde zavést podruhé jinou velikostí.
    const second = await users.createUser({
      email: "Vojta@Vexy.cz",
      name: "Dvojník",
      role: "admin",
      password: STRONG,
    });
    expect(second).toEqual({ ok: false, error: "duplicate" });
  });

  it("deaktivovaný účet se nedostane dovnitř", async () => {
    const adminId = await seedAdmin();
    const { userId } = await seedCaller();
    await users.setUserActive(userId, false);

    // Řádek existuje a heslo pořád sedí...
    const row = await users.getUserForLogin("jan@example.com");
    expect(row?.is_active).toBe(false);
    expect(await password.verifyPassword(STRONG, row!.password_hash)).toBe(true);

    // ...ale relace ho dovnitř nepustí, protože currentUser ho zahodí.
    expect(await users.getUser(userId).then((u) => u?.is_active)).toBe(false);
    expect(await users.getUser(adminId).then((u) => u?.is_active)).toBe(true);
  });
});

describe("session token", () => {
  it("nese id uživatele a dá se ověřit", async () => {
    const id = await seedAdmin();
    const token = auth.createSessionToken(id);
    expect(auth.readSessionUserId(token)).toBe(id);
  });

  it("podvržený token neprojde", async () => {
    const id = await seedAdmin();
    const token = auth.createSessionToken(id);
    const [userId, expiry, signature] = token.split(".");

    // Vyměnit id za cizí, podpis nechat.
    const otherId = "11111111-1111-1111-1111-111111111111";
    expect(auth.readSessionUserId(`${otherId}.${expiry}.${signature}`)).toBeNull();
    // Prodloužit platnost.
    expect(auth.readSessionUserId(`${userId}.${Number(expiry) + 1}.${signature}`)).toBeNull();
    // Rozbít podpis.
    expect(auth.readSessionUserId(`${userId}.${expiry}.deadbeef`)).toBeNull();
  });

  it("prošlý token neprojde", async () => {
    const id = await seedAdmin();
    expect(auth.readSessionUserId(auth.createSessionToken(id, Date.now() - 40 * 86_400_000))).toBeNull();
  });

  it("token nenese roli, takže se v něm nedá povýšit na admina", async () => {
    const { userId } = await seedCaller();
    const token = auth.createSessionToken(userId);
    expect(token).not.toContain("caller");
    expect(token).not.toContain("admin");
    // Role se čte z databáze, ne z cookie.
    expect((await users.getUser(userId))?.role).toBe("caller");
  });
});

describe("uživatelé a obchodní identita", () => {
  it("caller musí mít obchodní identitu", async () => {
    const result = await users.createUser({
      email: "bez@example.com",
      name: "Bez identity",
      role: "caller",
      password: STRONG,
    });
    expect(result).toEqual({ ok: false, error: "caller_required" });
  });

  it("admin obchodní identitu nedostane, ani když ji formulář pošle", async () => {
    const calling = await import("@/lib/queries/calling");
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    const result = await users.createUser({
      email: "admin@example.com",
      name: "Admin",
      role: "admin",
      callerId,
      password: STRONG,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await users.getUser(result.id))?.caller_id).toBeNull();
  });

  it("jedna obchodní identita patří nejvýš jednomu přihlášení", async () => {
    const { callerId } = await seedCaller();
    const second = await users.createUser({
      email: "druhy@example.com",
      name: "Druhý",
      role: "caller",
      callerId,
      password: STRONG,
    });
    expect(second).toEqual({ ok: false, error: "caller_taken" });
  });

  it("databáze nepustí callera bez identity ani obráceně", async () => {
    // Poslední pojistka pod aplikací: kdyby se kontrola v kódu obešla.
    await expect(sql`
      insert into users (email, name, role, password_hash) values ('x@y.cz', 'X', 'caller', 'h')
    `).rejects.toThrow();
  });

  it("poslední aktivní admin se nedá deaktivovat ani přepnout na callera", async () => {
    const adminId = await seedAdmin();
    // Volná obchodní identita: kdyby byla obsazená, refusal by přišel
    // z jiného důvodu a o posledním adminovi by test nic nedokázal.
    const calling = await import("@/lib/queries/calling");
    const freeCallerId = await calling.createCaller({ name: "Volný", email: null, phone: null });

    expect(await users.setUserActive(adminId, false)).toEqual({ ok: false, error: "last_admin" });
    expect(
      await users.updateUser(adminId, {
        email: "vojta@vexy.cz",
        name: "Vojta",
        role: "caller",
        callerId: freeCallerId,
      }),
    ).toEqual({ ok: false, error: "last_admin" });

    // S druhým adminem už to jde.
    await seedAdmin("druhy@vexy.cz");
    expect((await users.setUserActive(adminId, false)).ok).toBe(true);
  });

  it("změna hesla nezmění nic jiného", async () => {
    const { userId, callerId } = await seedCaller();
    expect((await users.setUserPassword(userId, "uplne-jine-heslo")).ok).toBe(true);

    const user = await users.getUser(userId);
    expect(user?.role).toBe("caller");
    expect(user?.caller_id).toBe(callerId);

    const row = await users.getUserForLogin("jan@example.com");
    expect(await password.verifyPassword("uplne-jine-heslo", row!.password_hash)).toBe(true);
    expect(await password.verifyPassword(STRONG, row!.password_hash)).toBe(false);
  });

  it("seznam uživatelů nikdy nevydá hash hesla", async () => {
    await seedAdmin();
    await seedCaller();
    const list = await users.listUsers();
    expect(list).toHaveLength(2);
    for (const user of list) {
      expect(JSON.stringify(user)).not.toContain("scrypt$");
      expect("password_hash" in user).toBe(false);
    }
  });
});
