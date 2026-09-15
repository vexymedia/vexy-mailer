import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { normaliseIco, parseExclusionsCsv } from "@/lib/csv";

/**
 * Import klientského vylučovacího seznamu.
 *
 * Seznam „tyhle firmy neoslovovat" umí tiše vyhodit stovky leadů. Proto
 * se páruje primárně podle IČO, nejednoznačné názvy se nepřiřazují samy
 * a opakovaný import téhož souboru nesmí nic zdvojit.
 */

let sql: typeof import("@/lib/db").sql;
let suppression: typeof import("@/lib/queries/suppression");

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  suppression = await import("@/lib/queries/suppression");
});

afterAll(async () => {
  await closeDatabase();
});

async function seedClientAndCompanies() {
  const [client] = await sql<{ id: string }[]>`
    insert into clients (name) values ('ASN Plus') returning id`;
  const ids: Record<string, string> = {};
  for (const [name, ico] of [
    ["Acme s.r.o.", "25596641"],
    ["Beta a.s.", "00075370"],
    ["Bez IČO s.r.o.", null],
    // Stejný základ názvu, jiná právní forma. `companies.name` je
    // unikátní, takže úplná shoda názvů nastat nemůže - nejednoznačnost
    // vzniká až po odstranění právní formy, což je přesně ten případ,
    // kdy se nesmí tipovat.
    ["Dvojník s.r.o.", "11111111"],
    ["Dvojník a.s.", "22222222"],
  ] as [string, string | null][]) {
    const [row] = await sql<{ id: string }[]>`
      insert into companies (name, status, ico) values (${name}, 'ready', ${ico}) returning id`;
    ids[ico ?? name] = row.id;
  }
  return { clientId: client.id, ids };
}

describe("normalizace IČO", () => {
  it("doplní vodicí nuly na osm míst a zahodí mezery", () => {
    expect(normaliseIco("75370")).toBe("00075370");
    expect(normaliseIco("00075370")).toBe("00075370");
    expect(normaliseIco(" 255 966 41 ")).toBe("25596641");
    expect(normaliseIco("255-966-41")).toBe("25596641");
  });

  it("odmítne, co IČO není", () => {
    expect(normaliseIco("CZ25596641")).toBeNull();
    expect(normaliseIco("nevím")).toBeNull();
    expect(normaliseIco("")).toBeNull();
    expect(normaliseIco(null)).toBeNull();
  });
});

describe("čtení souboru", () => {
  it("přečte IČO, název i důvod a rozpozná středník", () => {
    const result = parseExclusionsCsv("ico;nazev;duvod\n255 966 41;Acme s.r.o.;už je klientem\n");
    expect(result.rows).toEqual([
      { line: 2, ico: "25596641", name: "Acme s.r.o.", reason: "už je klientem" },
    ]);
  });

  it("úplně prázdný řádek se tiše přeskočí", () => {
    const result = parseExclusionsCsv("ico,nazev\n,\n25596641,Acme\n");
    expect(result.rows).toHaveLength(1);
  });

  it("řádek s obsahem, ale bez IČO i názvu, se ohlásí", () => {
    const result = parseExclusionsCsv("ico,nazev,duvod\n,,něco tu je\n25596641,Acme,\n");
    expect(result.rows).toHaveLength(1);
    expect(result.errors.join(" ")).toContain("chybí IČO i název");
  });

  it("neplatné IČO nezahodí řádek, jen upozorní a použije název", () => {
    const result = parseExclusionsCsv("ico,nazev\nCZ123,Acme s.r.o.\n");
    expect(result.rows[0].ico).toBeNull();
    expect(result.rows[0].name).toBe("Acme s.r.o.");
    expect(result.errors.join(" ")).toContain("není platné IČO");
  });

  it("soubor bez použitelné hlavičky odmítne", () => {
    expect(parseExclusionsCsv("a,b\n1,2\n").errors[0]).toContain("IČO nebo název");
  });
});

describe("párování na firmy", () => {
  it("IČO má přednost a napáruje i s jiným názvem", async () => {
    const { clientId, ids } = await seedClientAndCompanies();
    const [match] = await suppression.matchExclusions(clientId, [
      { line: 2, ico: "25596641", name: "ÚPLNĚ JINÝ NÁZEV", reason: null },
    ]);
    expect(match.kind).toBe("matched");
    expect(match.companyId).toBe(ids["25596641"]);
  });

  it("nezarovnané IČO se napáruje po normalizaci", async () => {
    const { clientId, ids } = await seedClientAndCompanies();
    const [match] = await suppression.matchExclusions(clientId, [
      { line: 2, ico: "75370", name: null, reason: null },
    ]);
    expect(match.companyId).toBe(ids["00075370"]);
  });

  it("jednoznačný název se napáruje i bez IČO", async () => {
    const { clientId, ids } = await seedClientAndCompanies();
    const [match] = await suppression.matchExclusions(clientId, [
      { line: 2, ico: null, name: "Bez IČO s.r.o.", reason: null },
    ]);
    expect(match.kind).toBe("matched");
    expect(match.companyId).toBe(ids["Bez IČO s.r.o."]);
  });

  it("název bez právní formy a s jinou velikostí písmen se pořád napáruje", async () => {
    const { clientId, ids } = await seedClientAndCompanies();
    const [match] = await suppression.matchExclusions(clientId, [
      { line: 2, ico: null, name: "BEZ IČO", reason: null },
    ]);
    expect(match.companyId).toBe(ids["Bez IČO s.r.o."]);
  });

  it("DVĚ firmy stejného názvu se nepřiřadí - jdou ke kontrole", async () => {
    const { clientId } = await seedClientAndCompanies();
    const [match] = await suppression.matchExclusions(clientId, [
      { line: 2, ico: null, name: "Dvojník", reason: null },
    ]);
    expect(match.kind).toBe("ambiguous");
    expect(match.companyId).toBeNull();
    expect(match.candidates).toHaveLength(2);
  });

  it("neznámá firma je not_found, ne tichý přeskok", async () => {
    const { clientId } = await seedClientAndCompanies();
    const [match] = await suppression.matchExclusions(clientId, [
      { line: 2, ico: "99999999", name: "Neexistuje s.r.o.", reason: null },
    ]);
    expect(match.kind).toBe("not_found");
  });

  it("už vyloučená firma se pozná a znovu se nezapíše", async () => {
    const { clientId, ids } = await seedClientAndCompanies();
    await suppression.excludeCompanyForClient({ clientId, companyId: ids["25596641"] });
    const [match] = await suppression.matchExclusions(clientId, [
      { line: 2, ico: "25596641", name: null, reason: null },
    ]);
    expect(match.kind).toBe("already_excluded");
  });

  it("párování nic nemění - je to jen náhled", async () => {
    const { clientId } = await seedClientAndCompanies();
    await suppression.matchExclusions(clientId, [
      { line: 2, ico: "25596641", name: null, reason: null },
      { line: 3, ico: "00075370", name: null, reason: null },
    ]);
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from client_company_exclusions`;
    expect(row.count).toBe(0);
  });
});

describe("zápis importu", () => {
  it("zapíše jen jednoznačné shody", async () => {
    const { clientId } = await seedClientAndCompanies();
    const matches = await suppression.matchExclusions(clientId, [
      { line: 2, ico: "25596641", name: null, reason: "už je klientem" },
      { line: 3, ico: null, name: "Dvojník", reason: null },
      { line: 4, ico: "99999999", name: null, reason: null },
    ]);
    const result = await suppression.applyExclusionImport({
      clientId, matches, defaultReason: "Import",
    });
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(2);

    const rows = await sql<{ reason: string }[]>`
      select reason from client_company_exclusions where client_id = ${clientId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("už je klientem");
  });

  it("OPAKOVANÝ import téhož seznamu nic nezdvojí", async () => {
    const { clientId } = await seedClientAndCompanies();
    const rows = [
      { line: 2, ico: "25596641", name: null, reason: null },
      { line: 3, ico: "00075370", name: null, reason: null },
    ];
    const first = await suppression.applyExclusionImport({
      clientId, matches: await suppression.matchExclusions(clientId, rows), defaultReason: "Import",
    });
    const second = await suppression.applyExclusionImport({
      clientId, matches: await suppression.matchExclusions(clientId, rows), defaultReason: "Import",
    });
    expect(first.created).toBe(2);
    expect(second.created).toBe(0);

    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from client_company_exclusions where client_id = ${clientId}`;
    expect(row.count).toBe(2);
  });

  it("import zapíše autora", async () => {
    const { clientId, ids } = await seedClientAndCompanies();
    const { createUser } = await import("@/lib/queries/users");
    const created = await createUser({
      email: "admin@vexy.test", name: "Admin", password: "dost-dlouhe-heslo",
      role: "admin", callerId: null,
    });
    if (!created.ok) throw new Error("uživatel se nezaložil");

    await suppression.excludeCompanyForClient({
      clientId, companyId: ids["25596641"], createdBy: created.id,
    });
    const [row] = await suppression.listClientExclusions({ clientId });
    expect(row.created_by_name).toBe("Admin");
  });

  it("vyloučení pro jednoho klienta nezaloží vyloučení pro druhého", async () => {
    const { clientId, ids } = await seedClientAndCompanies();
    const [other] = await sql<{ id: string }[]>`
      insert into clients (name) values ('VEXY') returning id`;
    await suppression.excludeCompanyForClient({ clientId, companyId: ids["25596641"] });
    expect(await suppression.listClientExclusions({ clientId: other.id })).toHaveLength(0);
  });
});
