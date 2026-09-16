import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Skript na založení administrátora.
 *
 * Spouští se ručně v terminálu, často ve spěchu a proti produkci, takže
 * se testuje jako skutečný proces - nikoli voláním vnitřní funkce.
 *
 * Hlavní věc, kterou hlídá: do výstupu se nikdy nesmí dostat heslo
 * z připojovací adresy. Při neplatné adrese ho Node vypisoval jako
 * součást `input` v TypeError, takže stačila uvozovka navíc nebo kus
 * dalšího příkazu v proměnné a heslo skončilo v terminálu i v historii.
 */

const SECRET = "TAJNE-HESLO-V-ADRESE-123";

async function script(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run(
      "node",
      ["scripts/create-admin.mjs", "--email", "test@vexy.test", "--name", "T"],
      { cwd: process.cwd(), env: { ...process.env, ADMIN_PASSWORD: "Testovaci-Heslo-2026", ...env } },
    );
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("heslo z připojovací adresy se nikdy nevypíše", () => {
  it("poškozená adresa: srozumitelná hláška, žádné heslo, žádný stack", async () => {
    // Přesně ten tvar, který vznikne, když se do proměnné dostane kus
    // dalšího příkazu nebo uvozovka navíc.
    const result = await script({
      DATABASE_URL: `"postgres://postgres:${SECRET}@db.example.com:6543/postgres`,
    });
    expect(result.code).toBe(1);
    expect(result.out).not.toContain(SECRET);
    expect(result.out).not.toContain("TypeError");
    expect(result.out).not.toContain("node_modules");
    expect(result.out).toContain("není platná adresa");
  });

  it("adresa s jiným protokolem se odmítne a heslo nevypíše", async () => {
    const result = await script({ DATABASE_URL: `https://user:${SECRET}@example.com/db` });
    expect(result.code).toBe(1);
    expect(result.out).not.toContain(SECRET);
    expect(result.out).toContain("postgresql://");
  });

  it("nedostupná databáze: hláška s hostem a portem, ale bez hesla", async () => {
    // Host a port jsou pro kontrolu užitečné a tajné nejsou.
    const result = await script({
      DATABASE_URL: `postgres://postgres:${SECRET}@127.0.0.1:1/nic`,
    });
    expect(result.code).toBe(1);
    expect(result.out).not.toContain(SECRET);
    expect(result.out).toContain("127.0.0.1:1");
  });

  it("chybějící adresa nespadne stack tracem", async () => {
    const result = await script({ DATABASE_URL: "" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("Chybí DATABASE_URL");
    expect(result.out).not.toContain("node_modules");
  });

  it("krátké heslo se odmítne dřív, než se cokoli zapíše", async () => {
    const result = await script({
      DATABASE_URL: `postgres://postgres:${SECRET}@127.0.0.1:1/nic`,
      ADMIN_PASSWORD: "krátké",
    });
    expect(result.code).toBe(1);
    expect(result.out).not.toContain(SECRET);
  });
});
