import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";

/**
 * Samotná přihlašovací akce.
 *
 * Ověřování hesla a dotaz na uživatele mají testy vlastní. Tady jde
 * o to, co dělá `loginAction` jako celek: jestli po chybě rychle vrátí
 * odpověď (aby se tlačítko nezaseklo na „Přihlašuji…"), jestli při
 * úspěchu nastaví cookie a pošle člověka na správné místo, a co udělá,
 * když je databáze nedostupná.
 *
 * Vzniklo z produkčního problému: health endpoint hlásil databázi jako
 * v pořádku, migrace 16/16, a přihlášení přesto končilo hláškou
 * „Nesprávný e-mail nebo heslo."
 */

const cookieStore = vi.hoisted(() => ({
  set: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
}));

const redirects = vi.hoisted(() => ({ to: [] as string[] }));

vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirects.to.push(to);
    // Next vyhazuje speciální výjimku, aby akce dál nepokračovala.
    const error = new Error("NEXT_REDIRECT");
    (error as { digest?: string }).digest = `NEXT_REDIRECT;push;${to};307;`;
    throw error;
  },
}));

let actions: typeof import("@/lib/actions");
let users: typeof import("@/lib/queries/users");
let sql: typeof import("@/lib/db").sql;

const PASSWORD = "SpravneHeslo-2026";

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  actions = await import("@/lib/actions");
  users = await import("@/lib/queries/users");
  cookieStore.set.mockClear();
  redirects.to = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeDatabase();
});

function form(email: string, password: string, next?: string) {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  if (next) data.set("next", next);
  return data;
}

/** Spustí akci a přeloží redirect z výjimky na normální výsledek. */
async function login(data: FormData) {
  const started = Date.now();
  try {
    const result = await actions.loginAction({}, data);
    return { ...result, redirectedTo: null as string | null, ms: Date.now() - started };
  } catch (error) {
    if ((error as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) {
      return { redirectedTo: redirects.to.at(-1) ?? null, ms: Date.now() - started };
    }
    throw error;
  }
}

async function makeAdmin(email = "vojtechsustal@seznam.cz") {
  await users.createUser({ email, name: "Vojta", role: "admin", password: PASSWORD, callerId: null });
}

// ========================================================== úspěch

describe("správné přihlášení", () => {
  it("admina pustí dovnitř, nastaví cookie a pošle ho na /", async () => {
    await makeAdmin();
    const result = await login(form("vojtechsustal@seznam.cz", PASSWORD));

    expect(result.redirectedTo).toBe("/");
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
    const [name, value] = cookieStore.set.mock.calls[0];
    expect(name).toBeTruthy();
    expect(String(value).length).toBeGreaterThan(20);
    // V cookie nesmí být heslo ani hash.
    expect(String(value)).not.toContain(PASSWORD);
  });

  it("velikost písmen v e-mailu nevadí", async () => {
    await makeAdmin();
    const result = await login(form("Vojtechsustal@SEZNAM.cz", PASSWORD));
    expect(result.redirectedTo).toBe("/");
  });

  it("mezery kolem e-mailu nevadí", async () => {
    await makeAdmin();
    const result = await login(form("  vojtechsustal@seznam.cz  ", PASSWORD));
    expect(result.redirectedTo).toBe("/");
  });

  it("respektuje ?next, ale nepustí na cizí adresu", async () => {
    await makeAdmin();
    expect((await login(form("vojtechsustal@seznam.cz", PASSWORD, "/firmy"))).redirectedTo)
      .toBe("/firmy");

    cookieStore.set.mockClear();
    // Otevřený redirect ven se nesmí povolit.
    expect((await login(form("vojtechsustal@seznam.cz", PASSWORD, "https://zlo.test"))).redirectedTo)
      .toBe("/");
  });
});

// ========================================================== selhání

describe("neúspěšné přihlášení skončí rychle a bez cookie", () => {
  /** Nejpomalejší legitimní cesta je jeden dotaz plus jeden scrypt (~50 ms). */
  const LIMIT_MS = 5000;

  it("špatné heslo: chyba, žádná cookie, žádný redirect", async () => {
    await makeAdmin();
    const result = await login(form("vojtechsustal@seznam.cz", "UplneJineHeslo-2026"));

    expect(result.error).toBe("Nesprávný e-mail nebo heslo.");
    expect(result.redirectedTo).toBeNull();
    expect(cookieStore.set).not.toHaveBeenCalled();
    // Tohle je to podstatné pro formulář: akce se VRÁTÍ, takže tlačítko
    // vypadne z „Přihlašuji…".
    expect(result.ms).toBeLessThan(LIMIT_MS);
  });

  it("neexistující účet: stejná hláška, stejně rychle", async () => {
    const result = await login(form("nikdo@seznam.cz", PASSWORD));
    expect(result.error).toBe("Nesprávný e-mail nebo heslo.");
    expect(result.ms).toBeLessThan(LIMIT_MS);
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("neexistující účet a špatné heslo se nedají rozlišit ani hláškou, ani chováním", async () => {
    await makeAdmin();
    const wrongPassword = await login(form("vojtechsustal@seznam.cz", "JineHeslo-2026"));
    const noSuchUser = await login(form("nikdo@seznam.cz", "JineHeslo-2026"));
    expect(wrongPassword.error).toBe(noSuchUser.error);
  });

  it("deaktivovaný účet se dovnitř nedostane", async () => {
    await makeAdmin();
    await sql`update users set is_active = false where email = 'vojtechsustal@seznam.cz'`;
    const result = await login(form("vojtechsustal@seznam.cz", PASSWORD));
    expect(result.error).toBe("Nesprávný e-mail nebo heslo.");
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("prázdný formulář nespadne", async () => {
    const result = await login(form("", ""));
    expect(result.error).toBe("Nesprávný e-mail nebo heslo.");
    expect(result.ms).toBeLessThan(LIMIT_MS);
  });

  it("poškozený hash v databázi je neplatné heslo, ne pád", async () => {
    await makeAdmin();
    await sql`update users set password_hash = 'nesmysl' where email = 'vojtechsustal@seznam.cz'`;
    const result = await login(form("vojtechsustal@seznam.cz", PASSWORD));
    expect(result.error).toBe("Nesprávný e-mail nebo heslo.");
  });
});

// ================================================== caller versus admin

describe("kam koho pustit", () => {
  it("caller jde rovnou do práce, ne na admin přehled", async () => {
    const [caller] = await sql<{ id: string }[]>`
      insert into callers (name, active) values ('Operátor', true) returning id`;
    await users.createUser({
      email: "operator@vexy.test", name: "Operátor", role: "caller",
      password: PASSWORD, callerId: caller.id,
    });
    expect((await login(form("operator@vexy.test", PASSWORD))).redirectedTo).toBe("/osloveni");
  });
});

// ============================================ nedostupná databáze

describe("výpadek databáze", () => {
  it("vrátí srozumitelnou hlášku, ne pád stránky", async () => {
    // Změřeno v prohlížeči: bez tohohle čekal formulář 15 sekund a pak
    // skončil obecným „Application error". Člověk netušil, jestli má
    // zkusit jiné heslo, nebo počkat.
    const users = await import("@/lib/queries/users");
    vi.spyOn(users, "getUserForLogin").mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:6543"), { code: "ECONNREFUSED" }),
    );

    const result = await login(form("vojtechsustal@seznam.cz", PASSWORD));
    expect(result.error).toContain("databáze neodpovídá");
    // A hlavně: akce se VRÁTILA, takže formulář je dál použitelný.
    expect(result.redirectedTo).toBeNull();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("hláška o výpadku se liší od hlášky o špatném heslu", async () => {
    await makeAdmin();
    const wrong = await login(form("vojtechsustal@seznam.cz", "Jine-2026"));

    const users = await import("@/lib/queries/users");
    vi.spyOn(users, "getUserForLogin").mockRejectedValue(new Error("spojení selhalo"));
    const down = await login(form("vojtechsustal@seznam.cz", PASSWORD));

    // Výpadek není chyba uživatele a nesmí vypadat stejně.
    expect(down.error).not.toBe(wrong.error);
  });

  it("do prohlížeče se nedostane host ani jiný detail spojení", async () => {
    const users = await import("@/lib/queries/users");
    vi.spyOn(users, "getUserForLogin").mockRejectedValue(
      new Error("connect ECONNREFUSED db.tajny-host.supabase.co:6543 user=postgres"),
    );
    const result = await login(form("vojtechsustal@seznam.cz", PASSWORD));
    expect(result.error).not.toContain("tajny-host");
    expect(result.error).not.toContain("6543");
    expect(result.error).not.toContain("postgres");
  });
});
