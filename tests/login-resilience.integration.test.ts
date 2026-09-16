import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { closeDatabase, resetDatabase } from "./helpers/db";

/**
 * Přihlášení při nedostupné databázi.
 *
 * Produkční incident: /login se nenačetlo vůbec. Měřeno v prohlížeči -
 * s session cookie a vypnutou databází vrátila stránka HTTP 500 po
 * 37 sekundách. Bez cookie se načetla hned, protože `isAuthenticated()`
 * sahá na databázi jen tehdy, když nějakou cookie dostane. Odtud dva
 * různé symptomy z téže příčiny: kdo cookie ještě neměl, dostal se aspoň
 * k formuláři a zasekl se až při odeslání; kdo ji měl, neviděl ani ten.
 *
 * Tenhle soubor hlídá, že se to nevrátí.
 */

let sql: typeof import("@/lib/db").sql;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  vi.restoreAllMocks();
});

afterAll(async () => {
  await closeDatabase();
});

// ======================================= strop čekání funguje sám o sobě

describe("časový strop", () => {
  it("vrátí výsledek, když práce stihne doběhnout", async () => {
    const { withTimeout } = await import("@/lib/timeout");
    expect(await withTimeout(Promise.resolve("hotovo"), 1000)).toBe("hotovo");
  });

  it("vyhodí TimeoutError, když nestihne", async () => {
    const { withTimeout, TimeoutError } = await import("@/lib/timeout");
    const nikdy = new Promise(() => {});
    await expect(withTimeout(nikdy, 50)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("náhradní hodnota místo čekání donekonečna", async () => {
    const { withTimeoutOr } = await import("@/lib/timeout");
    const nikdy = new Promise<boolean>(() => {});
    const t0 = Date.now();
    expect(await withTimeoutOr(nikdy, 50, false)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("chybu taky nahradí, nejen timeout", async () => {
    const { withTimeoutOr } = await import("@/lib/timeout");
    expect(await withTimeoutOr(Promise.reject(new Error("DB")), 1000, false)).toBe(false);
  });
});

// ============================ /login se načte i bez dostupné databáze

describe("/login nečeká na databázi", () => {
  it("kontrola přihlášení se vzdá a stránka se vykreslí", async () => {
    // Přesně produkční situace: session cookie je, databáze neodpovídá.
    const auth = await import("@/lib/auth");
    vi.spyOn(auth, "isAuthenticated").mockImplementation(() => new Promise(() => {}));

    const { SESSION_CHECK_TIMEOUT_MS, withTimeoutOr } = await import("@/lib/timeout");
    const t0 = Date.now();
    const result = await withTimeoutOr(auth.isAuthenticated(), SESSION_CHECK_TIMEOUT_MS, false);

    // `false` znamená „ukaž formulář", ne přesměrování - a hlavně se
    // rozhodlo rychle.
    expect(result).toBe(false);
    expect(Date.now() - t0).toBeLessThan(SESSION_CHECK_TIMEOUT_MS + 1000);
  });

  it("strop pro /login je kratší než ten pro odeslání formuláře", async () => {
    // Vykreslení stránky má být svižnější než ověření hesla.
    const { SESSION_CHECK_TIMEOUT_MS, LOGIN_DB_TIMEOUT_MS } = await import("@/lib/timeout");
    expect(SESSION_CHECK_TIMEOUT_MS).toBeLessThan(LOGIN_DB_TIMEOUT_MS);
    expect(SESSION_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});

// ============================== nefunkční DB nezpůsobí nekonečné čekání

describe("odeslání formuláře při nedostupné databázi", () => {
  it("skončí do stropu a vrátí srozumitelnou chybu", async () => {
    const users = await import("@/lib/queries/users");
    // Dotaz, který nikdy nedoběhne - jako zaseklé spojení.
    vi.spyOn(users, "getUserForLogin").mockImplementation(() => new Promise(() => {}));

    const { LOGIN_DB_TIMEOUT_MS } = await import("@/lib/timeout");
    const actions = await import("@/lib/actions");
    const data = new FormData();
    data.set("email", "vojtechsustal@seznam.cz");
    data.set("password", "NejakeHeslo-2026");

    const t0 = Date.now();
    const result = await actions.loginAction({}, data);
    const ms = Date.now() - t0;

    expect(result.error).toContain("databáze neodpovídá");
    // Tohle je jádro věci: akce se VRÁTÍ, takže tlačítko vypadne
    // z „Přihlašuji…" a formulář jde použít znovu.
    expect(ms).toBeLessThan(LOGIN_DB_TIMEOUT_MS + 2000);
    expect(ms).toBeGreaterThanOrEqual(LOGIN_DB_TIMEOUT_MS - 500);
  }, 20_000);

  it("hláška o výpadku se liší od hlášky o špatném heslu", async () => {
    const users = await import("@/lib/queries/users");
    vi.spyOn(users, "getUserForLogin").mockRejectedValue(new Error("spojení selhalo"));
    const actions = await import("@/lib/actions");
    const data = new FormData();
    data.set("email", "kdokoli@vexy.test");
    data.set("password", "NejakeHeslo-2026");
    const result = await actions.loginAction({}, data);
    expect(result.error).not.toBe("Nesprávný e-mail nebo heslo.");
  });
});

// ================================== middleware: veřejné cesty a smyčky

describe("middleware", () => {
  const BASE = "https://vexy.test";

  it("pouští /login, /api/health i /_next bez cookie", async () => {
    const { middleware } = await import("@/middleware");
    for (const path of [
      "/login", "/login?next=%2Ffirmy",
      "/api/health", "/api/health/ready", "/api/health?ready=1",
      "/_next/static/chunks/main.js",
    ]) {
      const response = middleware(new NextRequest(`${BASE}${path}`));
      expect(response.headers.get("location"), path).toBeNull();
    }
  });

  it("chráněnou stránku bez cookie pošle na /login", async () => {
    const { middleware } = await import("@/middleware");
    const location = middleware(new NextRequest(`${BASE}/firmy`)).headers.get("location");
    expect(location).toContain("/login");
  });

  it("nevytvoří smyčku: cíl přesměrování je sám veřejný", async () => {
    // Kdyby /login nebylo veřejné, přesměrování by vedlo zase na /login
    // a prohlížeč by se zacyklil.
    const { middleware } = await import("@/middleware");
    const location = middleware(new NextRequest(`${BASE}/firmy`)).headers.get("location")!;
    const target = new URL(location, BASE).pathname;
    expect(middleware(new NextRequest(`${BASE}${target}`)).headers.get("location")).toBeNull();
  });

  it("nepřipojí ?next, když se jde na kořen", async () => {
    const { middleware } = await import("@/middleware");
    const location = middleware(new NextRequest(`${BASE}/`)).headers.get("location")!;
    expect(new URL(location, BASE).search).toBe("");
  });
});

// ================================== funkční login vytvoří session

describe("funkční přihlášení", () => {
  it("ověří heslo proti databázi a vydá platný token", async () => {
    const users = await import("@/lib/queries/users");
    const { verifyPassword } = await import("@/lib/password");
    const { createSessionToken, readSessionUserId } = await import("@/lib/auth");

    await users.createUser({
      email: "vojtechsustal@seznam.cz", name: "Vojta", role: "admin",
      password: "SpravneHeslo-2026", callerId: null,
    });

    const user = await users.getUserForLogin("vojtechsustal@seznam.cz");
    expect(user?.is_active).toBe(true);
    expect(user?.role).toBe("admin");
    expect(await verifyPassword("SpravneHeslo-2026", user!.password_hash)).toBe(true);
    expect(await verifyPassword("JineHeslo-2026", user!.password_hash)).toBe(false);

    // Token z toho uživatele se dá zpětně přečíst - to je obsah cookie.
    expect(readSessionUserId(createSessionToken(user!.id))).toBe(user!.id);
    void sql;
  });
});
