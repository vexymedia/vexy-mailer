import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode } from "./helpers/fixtures";

/**
 * Ruční zakládání firem a kontaktů.
 *
 * Před pilotem to byla jediná věc, kvůli které se muselo do SQL editoru.
 * Testuje se hlavně to, co se dá zadat špatně: číslo, které nejde
 * vytočit, duplicitní e-mail a firma založená dvakrát.
 */

let sql: typeof import("@/lib/db").sql;
let companies: typeof import("@/lib/queries/companies");
let contacts: typeof import("@/lib/queries/contacts");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  companies = await import("@/lib/queries/companies");
  contacts = await import("@/lib/queries/contacts");
});

afterAll(async () => {
  await closeDatabase();
});

async function company(name = "Acme") {
  const created = await companies.createCompany({ name });
  if (!created.ok) throw new Error(created.error);
  return created.id;
}

describe("založení firmy", () => {
  it("založí firmu s kontextem a rovnou ji jde najít", async () => {
    const created = await companies.createCompany({
      name: "  Acme Industries ",
      website: "acme.cz",
      reason: "Výrobní firma, expanduje.",
      priority: "high",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const detail = await companies.getCompany(created.id);
    expect(detail?.name).toBe("Acme Industries");
    expect(detail?.website).toBe("acme.cz");
    expect(detail?.reason).toBe("Výrobní firma, expanduje.");
    expect(detail?.priority).toBe("high");

    const { rows } = await companies.listCompanies({ search: "acme" });
    expect(rows.map((r) => r.id)).toContain(created.id);
  });

  it("nezaloží tutéž firmu dvakrát, ani jinak napsanou", async () => {
    await company("Acme");
    const again = await companies.createCompany({ name: "  acme  " });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("duplicate");

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from companies`;
    expect(count).toBe(1);
  });

  it("odmítne prázdný název", async () => {
    const created = await companies.createCompany({ name: "   " });
    expect(created.ok).toBe(false);
  });
});

describe("založení kontaktu", () => {
  it("přidá kontakt k firmě a napojí ho na ni", async () => {
    const companyId = await company();
    const created = await contacts.createContact(companyId, {
      firstName: "Ana",
      lastName: "Nováková",
      position: "jednatelka",
      email: "Ana@Prospect.TEST",
      phone: "737 485 738",
      isPrimary: true,
    });
    expect(created.ok).toBe(true);

    const list = await companies.listCompanyContacts(companyId);
    expect(list).toHaveLength(1);
    expect(list[0].email).toBe("ana@prospect.test");
    expect(list[0].position).toBe("jednatelka");
    expect(list[0].is_primary).toBe(true);
    // Firma o něm ví jako o hlavním kontaktu.
    expect((await companies.getCompany(companyId))?.main_contact_phone).toBe("+420737485738");
  });

  it("normalizuje české číslo do E.164", async () => {
    const companyId = await company();
    const variants = [
      "737485738",
      "737 485 738",
      "+420 737 485 738",
      "00420737485738",
      "(737) 485-738",
    ];
    for (const [index, typed] of variants.entries()) {
      const stored = "+420737485738";
      const created = await contacts.createContact(companyId, {
        email: `varianta${index}@prospect.test`,
        phone: typed,
      });
      expect(created.ok, typed).toBe(true);
      if (!created.ok) continue;
      const [row] = await sql<{ phone: string }[]>`
        select phone from contacts where id = ${created.id}
      `;
      expect(row.phone, typed).toBe(stored);
    }
  });

  it("odmítne číslo, které nejde vytočit, a nic neuloží", async () => {
    const companyId = await company();
    const created = await contacts.createContact(companyId, {
      email: "spatne@prospect.test",
      phone: "zavolat na recepci",
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error).toBe("invalid_phone");

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from contacts`;
    expect(count).toBe(0);
  });

  it("odmítne neplatný e-mail a duplicitu", async () => {
    const companyId = await company();
    expect((await contacts.createContact(companyId, { email: "neni-email" })).ok).toBe(false);
    expect((await contacts.createContact(companyId, { email: "a@prospect.test" })).ok).toBe(true);

    const duplicate = await contacts.createContact(companyId, { email: "a@prospect.test" });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toBe("duplicate");
  });

  it("kontakt bez telefonu je v pořádku, jen se mu nedá volat", async () => {
    const companyId = await company();
    const created = await contacts.createContact(companyId, { email: "bez@prospect.test" });
    expect(created.ok).toBe(true);
    const [list] = await companies.listCompanyContacts(companyId);
    expect(list.phone).toBeNull();
    expect(list.callable).toBe(false);
  });
});

describe("úprava kontaktu", () => {
  it("upraví telefon a znormalizuje ho", async () => {
    const companyId = await company();
    const created = await contacts.createContact(companyId, {
      email: "ana@prospect.test",
      phone: "737485738",
    });
    if (!created.ok) throw new Error(created.error);

    const updated = await contacts.updateContact(created.id, {
      firstName: "Ana",
      email: "ana@prospect.test",
      phone: "602 111 222",
    });
    expect(updated.ok).toBe(true);

    const [row] = await sql<{ phone: string; first_name: string }[]>`
      select phone, first_name from contacts where id = ${created.id}
    `;
    expect(row.phone).toBe("+420602111222");
    expect(row.first_name).toBe("Ana");
  });

  it("špatné číslo při úpravě nepřepíše to původní", async () => {
    const companyId = await company();
    const created = await contacts.createContact(companyId, {
      email: "ana@prospect.test",
      phone: "737485738",
    });
    if (!created.ok) throw new Error(created.error);

    const updated = await contacts.updateContact(created.id, {
      email: "ana@prospect.test",
      phone: "123",
    });
    expect(updated.ok).toBe(false);

    const [row] = await sql<{ phone: string }[]>`
      select phone from contacts where id = ${created.id}
    `;
    expect(row.phone).toBe("+420737485738");
  });

  it("hlavní kontakt je ve firmě jen jeden", async () => {
    const companyId = await company();
    const first = await contacts.createContact(companyId, {
      email: "prvni@prospect.test",
      isPrimary: true,
    });
    const second = await contacts.createContact(companyId, {
      email: "druhy@prospect.test",
      isPrimary: true,
    });
    if (!first.ok || !second.ok) throw new Error("seed");

    const rows = await sql<{ id: string; is_primary: boolean }[]>`
      select id, is_primary from contacts where company_id = ${companyId}
    `;
    expect(rows.filter((r) => r.is_primary)).toHaveLength(1);
    expect(rows.find((r) => r.is_primary)?.id).toBe(second.id);
  });
});

describe("ručně založená firma jde rovnou volat", () => {
  it("založím firmu, kontakt s číslem, a hovor se dá zahájit", async () => {
    const calls = await import("@/lib/queries/calls");
    const calling = await import("@/lib/queries/calling");

    const companyId = await company("Ručně s.r.o.");
    const created = await contacts.createContact(companyId, {
      firstName: "Petr",
      email: "petr@rucne.test",
      phone: "737485738",
      isPrimary: true,
    });
    if (!created.ok) throw new Error(created.error);

    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    const started = await calls.startCall({ contactId: created.id, callerId });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    // Číslo se vytáčí ve tvaru, ve kterém se uložilo.
    expect(started.call.destination).toBe("+420737485738");
    expect(started.call.companyId).toBe(companyId);
  });
});
