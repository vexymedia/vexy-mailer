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
    vi.spyOn(users, "findUserForLogin").mockImplementation(
      () =>
        Object.assign(
          Promise.reject(
            Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:6543"), { code: "ECONNREFUSED" }),
          ),
          { cancel: () => {} },
        ) as never,
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

// ================================ rozpočty na databázi musí dávat smysl

describe("časové rozpočty přihlašovací cesty", () => {
  it("strop na dotaz je VĚTŠÍ než strop na spojení", async () => {
    // Tohle je invariant, jehož porušení položilo produkci. Když se strop
    // na dotaz rovnal `connect_timeout`, pokryl na studeném serverless
    // startu jen navázání spojení a na dotaz nezbylo nic - race byla
    // prohraná předem a přihlášení hlásilo „databáze neodpovídá",
    // přestože readiness přes tentýž pool procházel.
    const { LOGIN_DB_TIMEOUT_MS, DB_CONNECT_BUDGET_MS, DB_QUERY_BUDGET_MS } =
      await import("@/lib/timeout");
    expect(LOGIN_DB_TIMEOUT_MS).toBeGreaterThan(DB_CONNECT_BUDGET_MS);
    expect(LOGIN_DB_TIMEOUT_MS).toBe(DB_CONNECT_BUDGET_MS + DB_QUERY_BUDGET_MS);
  });

  it("rozpočet na spojení odpovídá connect_timeout databázového klienta", async () => {
    // Dvě čísla popisující tutéž věc. Kdyby se rozešla, invariant výš by
    // hlídal nesmysl.
    const { DB_CONNECT_BUDGET_MS } = await import("@/lib/timeout");
    const { sql } = await import("@/lib/db");
    const connectSeconds = (sql as unknown as { options: { connect_timeout: number } })
      .options.connect_timeout;
    expect(connectSeconds * 1000).toBe(DB_CONNECT_BUDGET_MS);
  });

  it("celý strop se vejde do deseti sekund", async () => {
    const { LOGIN_DB_TIMEOUT_MS } = await import("@/lib/timeout");
    expect(LOGIN_DB_TIMEOUT_MS).toBeLessThan(10_000);
  });
});

// ============================ strop se týká JEN databáze, ničeho jiného

describe("co pod časovým stropem neběží", () => {
  it("pomalé ověření hesla se nehlásí jako problém s databází", async () => {
    // scrypt je práce procesoru. Na vytížené instanci může trvat déle,
    // ale to není důvod tvrdit, že neodpovídá databáze.
    await makeAdmin();
    const password = await import("@/lib/password");
    const { LOGIN_DB_TIMEOUT_MS } = await import("@/lib/timeout");
    vi.spyOn(password, "verifyPassword").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, LOGIN_DB_TIMEOUT_MS + 500));
      return false;
    });

    const result = await login(form("vojtechsustal@seznam.cz", "JineHeslo-2026"));
    // Odmítnuté heslo, ne hláška o databázi.
    expect(result.error).toBe("Nesprávný e-mail nebo heslo.");
  }, 20_000);

  it("chyba při vydávání cookie se nehlásí jako problém s databází", async () => {
    await makeAdmin();
    cookieStore.set.mockImplementationOnce(() => {
      throw new Error("cookie store selhal");
    });
    await expect(login(form("vojtechsustal@seznam.cz", PASSWORD))).rejects.toThrow("cookie store");
  });
});

// ================================ rozlišení timeoutu od ostatních chyb

describe("hlášky rozlišují, co se stalo", () => {
  /** Tvar, který vrací postgres.js: thenable, který se dá zrušit. */
  const fakeQuery = <T,>(work: Promise<T>, cancel = () => {}) =>
    Object.assign(work, { cancel }) as never;

  it("vypršený strop se hlásí jako „neodpověděla včas“", async () => {
    const users = await import("@/lib/queries/users");
    vi.spyOn(users, "findUserForLogin").mockImplementation(() =>
      fakeQuery(new Promise(() => {})),
    );
    const result = await login(form("vojtechsustal@seznam.cz", PASSWORD));
    expect(result.error).toContain("neodpověděla včas");
  }, 20_000);

  it("vypršený strop dotaz opravdu zruší", async () => {
    // Bez zrušení zůstane dotaz viset na spojení a při `max: 1` se za něj
    // zařadí každé další přihlášení v téhle instanci.
    const users = await import("@/lib/queries/users");
    const cancel = vi.fn();
    vi.spyOn(users, "findUserForLogin").mockImplementation(() =>
      fakeQuery(new Promise(() => {}), cancel),
    );
    await login(form("vojtechsustal@seznam.cz", PASSWORD));
    expect(cancel).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("chyba z databáze se hlásí jako „neodpovídá“", async () => {
    const users = await import("@/lib/queries/users");
    vi.spyOn(users, "findUserForLogin").mockImplementation(() =>
      fakeQuery(
        Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
      ),
    );
    const result = await login(form("vojtechsustal@seznam.cz", PASSWORD));
    expect(result.error).toContain("neodpovídá");
    expect(result.error).not.toContain("včas");
  });

  it("žádná z hlášek nenese host, uživatele ani kód", async () => {
    const users = await import("@/lib/queries/users");
    vi.spyOn(users, "findUserForLogin").mockImplementation(() =>
      fakeQuery(
        Promise.reject(new Error("connect ECONNREFUSED db.tajny.supabase.co:6543 user=postgres")),
      ),
    );
    const result = await login(form("vojtechsustal@seznam.cz", PASSWORD));
    for (const secret of ["tajny", "6543", "postgres", "ECONNREFUSED"]) {
      expect(result.error).not.toContain(secret);
    }
  });
});

// ============================== visící promise nesmí shodit instanci

describe("timeout po sobě neuklizený nenechá", () => {
  it("pozdní odmítnutí prohrané práce nezpůsobí neodchycenou chybu", async () => {
    // Když vyhraje timeout, původní dotaz běží dál a může se později
    // odmítnout. Neodchycená rejection v serverless runtime shodí celou
    // instanci funkce - tedy i requesty, které s tím nemají nic společného.
    const { withTimeout, TimeoutError } = await import("@/lib/timeout");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    const pozdniChyba = new Promise((_, reject) => setTimeout(() => reject(new Error("pozdě")), 100));
    await expect(withTimeout(pozdniChyba, 20)).rejects.toBeInstanceOf(TimeoutError);
    await new Promise((r) => setTimeout(r, 300));

    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

describe("vypršený strop nesmí zablokovat pool", () => {
  /**
   * Tohle je ten test, který by produkční výpadek odhalil.
   *
   * postgres.js ruší svůj jediný časovač na první ReadyForQuery, takže
   * dotaz na navázaném spojení nemá strop žádný. Když se ho aplikace jen
   * přestane držet, dotaz zůstane viset NA SPOJENÍ - a protože postgres.js
   * další dotazy zařazuje i na obsazené spojení, při `max: 1` se za něj
   * postaví každé další přihlášení v téhle instanci. Z jednoho zádrhelu
   * je trvale rozbitá instance.
   */
  it("po zrušení dotazu projde další dotaz na témže spojení hned", async () => {
    const postgres = (await import("postgres")).default;
    const { TEST_DATABASE_URL } = await import("./helpers/db");
    const { withQueryTimeout, TimeoutError } = await import("@/lib/timeout");
    const sql = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, ssl: false, onnotice: () => {} });

    try {
      const blokujici = sql`select pg_sleep(20)`;
      await expect(withQueryTimeout(blokujici, 300)).rejects.toBeInstanceOf(TimeoutError);

      // Přesně to, co v produkci dělá další přihlášení v téže instanci.
      const zacatek = Date.now();
      const [row] = await sql<{ ok: number }[]>`select 1 as ok`;
      expect(row.ok).toBe(1);
      expect(Date.now() - zacatek).toBeLessThan(2000);
    } finally {
      await sql.end({ timeout: 0 }).catch(() => {});
    }
  }, 30_000);

  it("dotaz, který doběhne včas, se neruší", async () => {
    const { withQueryTimeout } = await import("@/lib/timeout");
    const cancel = vi.fn();
    const query = Object.assign(Promise.resolve(["hotovo"]), { cancel });

    await expect(withQueryTimeout(query, 5000)).resolves.toEqual(["hotovo"]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("selhání samotného zrušení neshodí přihlašovací cestu", async () => {
    const { withQueryTimeout, TimeoutError } = await import("@/lib/timeout");
    // Pooler nemusí CancelRequest propustit. Když zrušení selže, nejsme
    // na tom hůř než před opravou - ale hlášku musí uživatel dostat.
    const query = Object.assign(new Promise(() => {}), {
      cancel: () => {
        throw new Error("pooler zrušení nepropustil");
      },
    });

    await expect(withQueryTimeout(query, 50)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("zrušený dotaz nezpůsobí neodchycenou chybu", async () => {
    const { withQueryTimeout, TimeoutError } = await import("@/lib/timeout");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    let odmitnout: (e: Error) => void = () => {};
    const query = Object.assign(
      new Promise((_, reject) => {
        odmitnout = reject;
      }),
      // Zrušení dotaz odmítne - přesně jako postgres.js po CancelRequest.
      { cancel: () => setTimeout(() => odmitnout(new Error("57014")), 30) },
    );

    await expect(withQueryTimeout(query, 20)).rejects.toBeInstanceOf(TimeoutError);
    await new Promise((r) => setTimeout(r, 300));

    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });
});

describe("klient je pro serverless nastavený bezpečně", () => {
  it("drží max 1 spojení, bez prepared statements a s omezenou životností", async () => {
    const { sql } = await import("@/lib/db");
    const options = (sql as unknown as {
      options: { max: number; prepare: boolean; max_lifetime: number | null; connect_timeout: number };
    }).options;

    // Omezený, ale ne na jedno spojení: jednička na transaction pooleru
    // znamená, že se přihlášení seřadí za každý jiný request na téže
    // instanci. Viz lib/db.ts.
    expect(options.max).toBeGreaterThan(1);
    expect(options.max).toBeLessThanOrEqual(10);
    // Transaction pooler prepared statements neumí.
    expect(options.prepare).toBe(false);
    // Zmrazená serverless instance se nesmí probudit s letitým socketem.
    expect(options.max_lifetime).toBeGreaterThan(0);
    expect(options.max_lifetime).toBeLessThanOrEqual(600);
    // Životnost spojení musí být delší než strop přihlášení, jinak by se
    // spojení zahazovalo pod rukama běžícímu dotazu.
    const { LOGIN_DB_TIMEOUT_MS } = await import("@/lib/timeout");
    expect((options.max_lifetime ?? 0) * 1000).toBeGreaterThan(LOGIN_DB_TIMEOUT_MS);
  });
});

describe("zaseknutý pool se dá zahodit", () => {
  /**
   * Bez tohohle zůstane instance rozbitá, dokud ji hosting nerecykluje.
   * Měřeno na produkci: GET / skončil 504 po 300 sekundách, protože stránky
   * na rozdíl od přihlášení žádný strop nemají a čekaly na spojení, které
   * se nikdy neuvolnilo.
   */
  it("výměna klienta je vidět i v modulech, které si `sql` naimportovaly", async () => {
    const db = await import("@/lib/db");
    const before = db.sql;

    db.resetDbClient();

    // ESM export je živá vazba - kdyby to webpack nebo vitest rozbily,
    // moduly by dál držely zaseknutého klienta a oprava by byla k ničemu.
    expect(db.sql).not.toBe(before);
    const [row] = await db.sql<{ ok: number }[]>`select 1 as ok`;
    expect(row.ok).toBe(1);
  }, 20_000);

  it("dotaz s modulovým fragmentem funguje i po výměně klienta", async () => {
    // `users.ts` si drží COLUMNS = sql`...` z původního klienta. Kdyby
    // fragment po výměně přestal platit, rozbilo by se přihlášení právě
    // ve chvíli, kdy se ho snažíme zachránit.
    await makeAdmin();
    const db = await import("@/lib/db");
    const usersQueries = await import("@/lib/queries/users");
    const [{ id }] = await db.sql<{ id: string }[]>`select id from users limit 1`;

    db.resetDbClient();

    const user = await usersQueries.getUser(id);
    expect(user?.email).toBe("vojtechsustal@seznam.cz");
    const forLogin = await usersQueries.getUserForLogin("vojtechsustal@seznam.cz");
    expect(forLogin?.password_hash).toBeTruthy();
  }, 20_000);
});
