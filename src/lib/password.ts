import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Hashování hesel.
 *
 * Používá se scrypt z node:crypto - standardní, paměťově náročná funkce
 * navržená přesně na tohle. Žádná vlastní kryptografie a žádná další
 * závislost: nejmenší varianta, která je zároveň důvěryhodná.
 *
 * Formát uloženého hesla:
 *
 *   scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 *
 * Parametry se ukládají s hashem, takže se dají v budoucnu zvýšit, aniž
 * by se znehodnotila stávající hesla.
 */

/**
 * promisify(scrypt) zahodí přetížení s options, takže se obaluje ručně.
 */
function derive(
  password: string,
  salt: Buffer,
  keyBytes: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyBytes, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * N=16384 je doporučené minimum pro interaktivní přihlášení; r a p jsou
 * standardní. Hashování trvá kolem 50 ms, což je pro přihlášení
 * nepostřehnutelné a pro útočníka drahé.
 */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/** scrypt potřebuje povolit tolik paměti, kolik si N a r vyžádají. */
const MAX_MEMORY = 256 * N * R;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await derive(password, salt, KEY_BYTES, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEMORY,
  });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Ověří heslo proti uloženému hashi.
 *
 * Nikdy nevyhazuje výjimku - poškozený nebo neznámý formát je prostě
 * neplatné heslo. Přihlašovací cesta se nesmí dát rozbít tím, že někdo
 * do sloupce zapíše nesmysl.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, rawN, rawR, rawP, saltB64, hashB64] = parts;
    const n = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

    const expected = Buffer.from(hashB64, "base64");
    if (expected.length === 0) return false;

    const derived = await derive(password, Buffer.from(saltB64, "base64"), expected.length, {
      N: n,
      r,
      p,
      maxmem: Math.max(MAX_MEMORY, 256 * n * r),
    });
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// Pravidla pro heslo žijí vedle, aby si je mohl načíst i formulář
// v prohlížeči - tenhle modul s sebou tahá node:crypto.
export { MIN_PASSWORD_LENGTH, passwordProblem } from "./password-rules";
