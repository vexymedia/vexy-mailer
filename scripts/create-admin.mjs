#!/usr/bin/env node
/**
 * Založí prvního administrátora.
 *
 * Bez něj se po migraci na uživatelské účty nikdo nepřihlásí - a to je
 * záměr: žádné výchozí heslo, žádný účet v repozitáři, žádná trvalá
 * zadní vrátka.
 *
 *   node scripts/create-admin.mjs
 *   node scripts/create-admin.mjs --email vojta@vexy.cz --name "Vojta"
 *
 * Heslo se zadává interaktivně a neukládá se do historie shellu. Když
 * terminál interaktivní není (CI, pipe), vezme se z ADMIN_PASSWORD.
 *
 * Skript jde spustit opakovaně: existujícímu účtu jen nastaví nové heslo
 * a roli admina.
 */
import { createInterface } from "node:readline/promises";
import { randomBytes, scrypt } from "node:crypto";
import { stdin, stdout } from "node:process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config as loadEnv } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: join(root, ".env.local"), quiet: true });
loadEnv({ path: join(root, ".env"), quiet: true });

const MIN_PASSWORD_LENGTH = 10;

/** Stejný formát jako src/lib/password.ts. Musí zůstat v souladu. */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    const N = 16_384;
    const r = 8;
    const p = 1;
    scrypt(password, salt, 32, { N, r, p, maxmem: 256 * N * r }, (error, key) => {
      if (error) reject(error);
      else resolve(["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$"));
    });
  });
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : null;
}

/** Heslo se při psaní nevypisuje. */
async function askHidden(rl, question) {
  const onKeypress = () => {
    // readline už znak vypsal; přepíše se výzvou bez něj.
    stdout.write(`\x1b[2K\r${question}`);
  };
  stdout.write(question);
  stdin.on("data", onKeypress);
  try {
    return (await rl.question("")).trim();
  } finally {
    stdin.off("data", onKeypress);
    stdout.write("\n");
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Chybí DATABASE_URL.");
  process.exit(1);
}

/**
 * Tvar adresy se ověří DŘÍV, než se předá do postgres().
 *
 * Při neplatné adrese vyhodí Node TypeError, jehož vlastnost `input`
 * nese celou adresu - tedy i heslo - a ta skončí v terminálu a v historii.
 * Takhle se heslo dá prozradit omylem: stačí, aby se do proměnné dostal
 * kus dalšího příkazu nebo uvozovka navíc.
 *
 * Reprodukováno, ne odhadnuto.
 */
let parsed;
try {
  parsed = new URL(url);
} catch {
  console.error("DATABASE_URL není platná adresa.");
  console.error("Musí obsahovat jen připojovací řetězec - bez uvozovek a bez dalších příkazů.");
  process.exit(1);
}
if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
  console.error(`DATABASE_URL musí začínat "postgresql://", ne "${parsed.protocol}//".`);
  process.exit(1);
}
// Host a port jsou pro kontrolu užitečné a tajné nejsou. Heslo ani
// uživatel se nevypisují nikdy.
console.log(`Připojuji se k ${parsed.hostname}:${parsed.port || 5432}.`);

// Stejná pravidla jako runtime klient a migrační runner: Supabase
// vyžaduje TLS a přes transaction pooler nefungují prepared statements.
// Bez explicitního `ssl` by se spojení na pooler neotevřelo, pokud by
// adresa ze schránky náhodou neměla `?sslmode=require` - a hláška by
// vypadala jako chyba přihlašovacích údajů.
const sql = postgres(url, {
  max: 1,
  prepare: false,
  ssl: url.includes("sslmode=disable") ? false : "require",
});

try {
  const [table] = await sql`select to_regclass('public.users') as name`;
  if (!table?.name) {
    console.error("Tabulka users neexistuje. Nejdřív spusťte: npm run db:migrate");
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });

  const email = (arg("email") ?? (await rl.question("E-mail: "))).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("To nevypadá jako e-mailová adresa.");
    process.exit(1);
  }

  const name = (arg("name") ?? (await rl.question("Jméno: "))).trim() || email;

  let password = process.env.ADMIN_PASSWORD ?? "";
  if (!password) {
    if (!stdin.isTTY) {
      console.error("Neinteraktivní běh: nastavte heslo přes ADMIN_PASSWORD.");
      process.exit(1);
    }
    password = await askHidden(rl, "Heslo: ");
    const again = await askHidden(rl, "Heslo znovu: ");
    if (password !== again) {
      console.error("Hesla se neshodují.");
      process.exit(1);
    }
  }
  rl.close();

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Heslo musí mít aspoň ${MIN_PASSWORD_LENGTH} znaků.`);
    process.exit(1);
  }

  const hash = await hashPassword(password);
  const [existing] = await sql`select id from users where lower(email) = ${email}`;

  if (existing) {
    await sql`
      update users
         set password_hash = ${hash}, name = ${name}, role = 'admin',
             caller_id = null, is_active = true, updated_at = now()
       where id = ${existing.id}
    `;
    console.log(`Administrátor ${email} aktualizován.`);
  } else {
    await sql`
      insert into users (email, name, role, password_hash)
      values (${email}, ${name}, 'admin', ${hash})
    `;
    console.log(`Administrátor ${email} vytvořen.`);
  }
  console.log("Přihlaste se na /login tímhle e-mailem a heslem.");
} catch (error) {
  // Chyba z postgres.js může nést hosta, uživatele i celou adresu. Do
  // terminálu proto jde jen to, co se s tím dá dělat.
  const code = error?.code;
  if (code === "28P01" || code === "28000") {
    console.error("Databáze odmítla přihlašovací údaje. Zkontrolujte heslo v připojovací adrese.");
  } else if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
    console.error(`K databázi se nepodařilo připojit (${parsed.hostname}:${parsed.port || 5432}).`);
  } else {
    console.error("Založení administrátora selhalo.");
    console.error(`  ${error?.message ?? error}`);
  }
  process.exitCode = 1;
} finally {
  await sql.end();
}
