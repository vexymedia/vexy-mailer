import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Co smí caller a co ne.
 *
 * Testuje se server, ne menu. Externí caller dostane e-mail a heslo;
 * cokoliv, co mu server pustí, může vidět - bez ohledu na to, jestli
 * na to vede odkaz.
 *
 * `cookies()` a `redirect()` jsou mimo request nedostupné, takže se
 * nahrazují: cookie vrací session token zvoleného uživatele a redirect
 * vyhodí značkovanou výjimku, kterou testy chytají. Všechno ostatní -
 * ověření podpisu, načtení uživatele z databáze, kontrola role - běží
 * doopravdy.
 */

/** Kdo je právě přihlášený. Nastavuje se v jednotlivých testech. */
let sessionToken: string | null = null;

class RedirectError extends Error {
  constructor(public target: string) {
    super(`redirect:${target}`);
  }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "vexy_session" && sessionToken ? { name, value: sessionToken } : undefined,
    set: () => {},
    delete: () => {},
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new RedirectError(target);
  },
  notFound: () => {
    throw new Error("not_found");
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let sql: typeof import("@/lib/db").sql;
let users: typeof import("@/lib/queries/users");
let auth: typeof import("@/lib/auth");
let actions: typeof import("@/lib/actions");
let callerSession: typeof import("@/lib/caller-session");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  sessionToken = null;
  ({ sql } = await import("@/lib/db"));
  users = await import("@/lib/queries/users");
  auth = await import("@/lib/auth");
  actions = await import("@/lib/actions");
  callerSession = await import("@/lib/caller-session");
});

afterAll(async () => {
  await closeDatabase();
});

const STRONG = "dost-dlouhe-heslo";

async function seedPeople() {
  const calling = await import("@/lib/queries/calling");
  const janCallerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
  const petrCallerId = await calling.createCaller({ name: "Petr", email: null, phone: null });

  const admin = await users.createUser({
    email: "vojta@vexy.cz", name: "Vojta", role: "admin", password: STRONG,
  });
  const jan = await users.createUser({
    email: "jan@example.com", name: "Jan Novák", role: "caller",
    callerId: janCallerId, password: STRONG,
  });
  const petr = await users.createUser({
    email: "petr@example.com", name: "Petr Svoboda", role: "caller",
    callerId: petrCallerId, password: STRONG,
  });
  if (!admin.ok || !jan.ok || !petr.ok) throw new Error("seed selhal");

  return {
    adminId: admin.id,
    jan: { userId: jan.id, callerId: janCallerId },
    petr: { userId: petr.id, callerId: petrCallerId },
  };
}

function signIn(userId: string) {
  sessionToken = auth.createSessionToken(userId);
}

/** Spustí něco, co má skončit přesměrováním, a vrátí kam. */
async function redirectTarget(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof RedirectError ? error.target : null;
  }
}

describe("guardy", () => {
  it("nepřihlášeného pošlou na login", async () => {
    await seedPeople();
    sessionToken = null;

    expect(await redirectTarget(() => auth.requireUser())).toBe("/login");
    expect(await redirectTarget(() => auth.requireAdmin())).toBe("/login");
    expect(await redirectTarget(() => auth.requireCaller())).toBe("/login");
  });

  it("admina pustí všude, kam má", async () => {
    const { adminId } = await seedPeople();
    signIn(adminId);

    expect((await auth.requireUser()).role).toBe("admin");
    expect((await auth.requireAdmin()).role).toBe("admin");
    // Admin není caller - obchodní identitu nemá.
    expect(await redirectTarget(() => auth.requireCaller())).toBe("/nemate-pristup");
  });

  it("callera do administrace nepustí", async () => {
    const { jan } = await seedPeople();
    signIn(jan.userId);

    expect((await auth.requireUser()).role).toBe("caller");
    expect(await redirectTarget(() => auth.requireAdmin())).toBe("/nemate-pristup");
    expect((await auth.requireCaller()).caller_id).toBe(jan.callerId);
  });

  it("deaktivovaný caller je venku, i když má platnou cookie", async () => {
    const { jan } = await seedPeople();
    signIn(jan.userId);
    expect(await auth.currentUser()).not.toBeNull();

    await users.setUserActive(jan.userId, false);
    // Cookie se nemění - a přesto už dovnitř nepustí.
    expect(await auth.currentUser()).toBeNull();
    expect(await redirectTarget(() => auth.requireUser())).toBe("/login");
  });

  it("smazaný uživatel s platnou cookie taky neprojde", async () => {
    const { jan } = await seedPeople();
    signIn(jan.userId);
    await sql`delete from users where id = ${jan.userId}`;
    expect(await auth.currentUser()).toBeNull();
  });
});

describe("caller nemá přístup k administraci", () => {
  it("nespustí adminské akce", async () => {
    const { jan } = await seedPeople();
    signIn(jan.userId);

    const form = new FormData();
    form.set("test_mode", "on");
    form.set("test_behavior", "simulate");
    expect(await redirectTarget(() => actions.saveSettingsAction({}, form))).toBe("/nemate-pristup");

    const workerForm = new FormData();
    expect(await redirectTarget(() => actions.runWorkerNowAction({}))).toBe("/nemate-pristup");
    expect(await redirectTarget(() => actions.saveMailboxAction({}, workerForm))).toBe(
      "/nemate-pristup",
    );
  });

  it("nezaloží ani neupraví uživatele", async () => {
    const { jan } = await seedPeople();
    signIn(jan.userId);

    const form = new FormData();
    form.set("name", "Podvodník");
    form.set("email", "podvod@example.com");
    form.set("role", "admin");
    form.set("password", STRONG);
    expect(await redirectTarget(() => actions.saveUserAction({}, form))).toBe("/nemate-pristup");

    // A opravdu nevznikl.
    expect(await users.getUserForLogin("podvod@example.com")).toBeNull();
  });

  it("nezmění heslo jinému uživateli", async () => {
    const { jan, adminId } = await seedPeople();
    signIn(jan.userId);

    const form = new FormData();
    form.set("user_id", adminId);
    form.set("password", "prevzate-heslo-admina");
    expect(await redirectTarget(() => actions.setUserPasswordAction({}, form))).toBe(
      "/nemate-pristup",
    );

    // Adminovo heslo je pořád to původní.
    const password = await import("@/lib/password");
    const admin = await users.getUserForLogin("vojta@vexy.cz");
    expect(await password.verifyPassword(STRONG, admin!.password_hash)).toBe(true);
  });

  it("nedeaktivuje jiného uživatele", async () => {
    const { jan, adminId } = await seedPeople();
    signIn(jan.userId);

    const form = new FormData();
    form.set("user_id", adminId);
    form.set("active", "no");
    expect(await redirectTarget(() => actions.toggleUserAction({}, form))).toBe("/nemate-pristup");
    expect((await users.getUser(adminId))?.is_active).toBe(true);
  });

  it("nezmění obchodní identitu, pod kterou volá", async () => {
    const { jan, petr } = await seedPeople();
    signIn(jan.userId);

    const form = new FormData();
    form.set("caller_id", petr.callerId);
    expect(await redirectTarget(() => actions.selectCallerAction({}, form))).toBe(
      "/nemate-pristup",
    );
    // Ani po pokusu se identita nezměnila.
    expect(await callerSession.getSelectedCallerId()).toBe(jan.callerId);
  });
});

describe("identita pro zápis hovoru", () => {
  it("se u callera bere z přihlášení", async () => {
    const { jan, petr } = await seedPeople();

    signIn(jan.userId);
    expect(await callerSession.getSelectedCallerId()).toBe(jan.callerId);

    signIn(petr.userId);
    expect(await callerSession.getSelectedCallerId()).toBe(petr.callerId);
  });

  it("se u callera nedá přepsat cookie", async () => {
    const { jan, petr } = await seedPeople();
    signIn(jan.userId);

    // I kdyby si Jan podstrčil Petrovu identitu do cookie, server ji
    // ignoruje: u callera rozhoduje výhradně přihlášení.
    await callerSession.setSelectedCallerId(petr.callerId);
    expect(await callerSession.getSelectedCallerId()).toBe(jan.callerId);
  });

  it("nepřihlášený žádnou identitu nemá", async () => {
    await seedPeople();
    sessionToken = null;
    expect(await callerSession.getSelectedCallerId()).toBeNull();
  });

  it("hovor se připíše přihlášenému, ne tomu, koho pošle formulář", async () => {
    const { jan, petr } = await seedPeople();
    const seeded = await seedCampaign({
      contacts: [{ email: "lead@test.test", first_name: "Lead", company: "Acme" }],
    });
    await sql`update campaigns set calling_enabled = true where id = ${seeded.campaignId}`;
    await sql`update contacts set phone = '+420777123456' where email = 'lead@test.test'`;

    signIn(jan.userId);
    const form = new FormData();
    form.set("campaign_contact_id", seeded.campaignContactIds[0]);
    form.set("outcome", "no_answer");
    // Podvržená identita ve formuláři - akce ji vůbec nečte.
    form.set("caller_id", petr.callerId);
    await actions.logCallAction({}, form);

    const [activity] = await sql<{ caller_id: string }[]>`
      select caller_id from call_activities
    `;
    expect(activity.caller_id).toBe(jan.callerId);
    expect(activity.caller_id).not.toBe(petr.callerId);
  });
});

describe("data cizího callera", () => {
  it("caller se nedostane na stav cizího hovoru ani přes uhodnuté id", async () => {
    const { jan, petr } = await seedPeople();
    const calls = await import("@/lib/queries/calls");

    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email, first_name, phone)
      values ('lead@test.test', 'Lead', '+420777123456')
      returning id
    `;
    // Hovor patří Petrovi.
    const started = await calls.startCall({ contactId: contact.id, callerId: petr.callerId });
    if (!started.ok) throw new Error(started.error);
    await calls.attachProviderCall(started.call.callId, "CA-petr", null);

    const { GET } = await import("@/app/api/calling/calls/[id]/route");
    const params = { params: Promise.resolve({ id: started.call.callId }) };

    // Jan zná id (třeba ho uhodl) - a stejně nedostane nic.
    signIn(jan.userId);
    expect((await GET(new Request("http://localhost/x"), params)).status).toBe(404);

    // Petrovi ten samý hovor server vydá.
    signIn(petr.userId);
    expect((await GET(new Request("http://localhost/x"), params)).status).toBe(200);
  });

  it("nepřihlášený nedostane stav hovoru vůbec", async () => {
    const { petr } = await seedPeople();
    const calls = await import("@/lib/queries/calls");
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email, first_name, phone)
      values ('lead@test.test', 'Lead', '+420777123456')
      returning id
    `;
    const started = await calls.startCall({ contactId: contact.id, callerId: petr.callerId });
    if (!started.ok) throw new Error(started.error);

    sessionToken = null;
    const { GET } = await import("@/app/api/calling/calls/[id]/route");
    const response = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ id: started.call.callId }),
    });
    expect(response.status).toBe(401);
  });
});

describe("reporting po zavedení účtů", () => {
  it("rozdělí hovory mezi lidi podle přihlášení", async () => {
    const { jan, petr } = await seedPeople();
    const calls = await import("@/lib/queries/calls");
    const reporting = await import("@/lib/queries/reporting");

    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email, first_name, phone)
      values ('lead@test.test', 'Lead', '+420777123456')
      returning id
    `;

    /** Hovor tak, jak vzniká z cockpitu: identita ze session. */
    async function dial(userId: string, sid: string, answered: boolean) {
      signIn(userId);
      const callerId = await callerSession.getSelectedCallerId();
      const started = await calls.startCall({ contactId: contact.id, callerId });
      if (!started.ok) throw new Error(started.error);
      await calls.attachProviderCall(started.call.callId, sid, null);
      await calls.recordCallStatus({
        providerCallSid: sid,
        status: answered ? "completed" : "no_answer",
        durationSeconds: answered ? 35 : null,
      });
    }

    await dial(jan.userId, "CA-j1", true);
    await dial(jan.userId, "CA-j2", false);
    await dial(petr.userId, "CA-p1", true);

    const byCaller = await reporting.getMetricsByCaller();
    expect(byCaller.get(jan.callerId)).toMatchObject({ attempts: 2, connected: 1 });
    expect(byCaller.get(petr.callerId)).toMatchObject({ attempts: 1, connected: 1 });
  });
});

/**
 * Klientská vyloučení firem.
 *
 * Vyloučit firmu je rozhodnutí o obchodním vztahu, ne výsledek hovoru.
 * Caller na to nemá, a nejde jen o schované tlačítko: testuje se přímo
 * server action, tedy stejná cesta, po které by šel ruční POST mimo UI.
 */
describe("klientská vyloučení a oprávnění", () => {
  async function company() {
    const [row] = await sql<{ id: string }[]>`
      insert into companies (name, status, ico) values ('Acme s.r.o.', 'ready', '25596641')
      returning id`;
    const [client] = await sql<{ id: string }[]>`
      insert into clients (name) values ('ASN Plus') returning id`;
    return { companyId: row.id, clientId: client.id };
  }

  function form(fields: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  it("caller firmu vyloučit nemůže - ani přímým voláním akce", async () => {
    const people = await seedPeople();
    const { companyId, clientId } = await company();
    signIn(people.jan.userId);

    expect(
      await redirectTarget(() =>
        actions.excludeCompanyAction({}, form({ company_id: companyId, client_id: clientId })),
      ),
    ).toBe("/nemate-pristup");

    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from client_company_exclusions`;
    expect(row.count).toBe(0);
  });

  it("nepřihlášený nedostane ani chybovou hlášku, jen login", async () => {
    const { companyId, clientId } = await company();
    sessionToken = null;
    expect(
      await redirectTarget(() =>
        actions.excludeCompanyAction({}, form({ company_id: companyId, client_id: clientId })),
      ),
    ).toBe("/login");
  });

  it("caller nemůže vyloučení ani zrušit", async () => {
    const people = await seedPeople();
    const { companyId, clientId } = await company();
    const suppression = await import("@/lib/queries/suppression");
    await suppression.excludeCompanyForClient({ clientId, companyId });
    const [exclusion] = await suppression.listClientExclusions({ clientId });

    signIn(people.jan.userId);
    expect(
      await redirectTarget(() =>
        actions.removeCompanyExclusionAction({}, form({ exclusion_id: exclusion.id })),
      ),
    ).toBe("/nemate-pristup");
    expect(await suppression.listClientExclusions({ clientId })).toHaveLength(1);
  });

  it("caller nemůže importovat vylučovací seznam", async () => {
    const people = await seedPeople();
    await company();
    signIn(people.jan.userId);
    const data = new FormData();
    data.set("client_id", "x");
    expect(
      await redirectTarget(() => actions.previewExclusionImportAction({}, data)),
    ).toBe("/nemate-pristup");
  });

  it("administrátor firmu vyloučí a podepíše se pod to", async () => {
    const people = await seedPeople();
    const { companyId, clientId } = await company();
    signIn(people.adminId);

    const result = await actions.excludeCompanyAction(
      {}, form({ company_id: companyId, client_id: clientId, reason: "Už je klientem." }),
    );
    expect(result.success).toBeTruthy();

    const suppression = await import("@/lib/queries/suppression");
    const [row] = await suppression.listClientExclusions({ clientId });
    expect(row.company_name).toBe("Acme s.r.o.");
    expect(row.ico).toBe("25596641");
    expect(row.created_by_name).toBe("Vojta");
  });

  it("dvakrát totéž vyloučení se neuloží dvakrát a řekne se proč", async () => {
    const people = await seedPeople();
    const { companyId, clientId } = await company();
    signIn(people.adminId);

    await actions.excludeCompanyAction({}, form({ company_id: companyId, client_id: clientId }));
    const second = await actions.excludeCompanyAction(
      {}, form({ company_id: companyId, client_id: clientId }),
    );
    expect(second.error).toContain("už vyloučená");

    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from client_company_exclusions`;
    expect(row.count).toBe(1);
  });

  it("vyloučení bez vybraného klienta neprojde", async () => {
    const people = await seedPeople();
    const { companyId } = await company();
    signIn(people.adminId);
    const result = await actions.excludeCompanyAction({}, form({ company_id: companyId }));
    expect(result.error).toBeTruthy();
  });
});
