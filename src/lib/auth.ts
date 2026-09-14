import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hmacHex, safeEqual } from "./crypto";
import { env } from "./env";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./session-cookie";
import { getUser, type User, type UserRole } from "./queries/users";

/**
 * Přihlášení a oprávnění.
 *
 * Session nese jen id uživatele a dobu platnosti, podepsané HMACem.
 * Role se NIKDY nebere z cookie - načítá se z databáze při každém
 * požadavku. Díky tomu se deaktivace i změna role projeví okamžitě
 * a podepsaná cookie se nedá použít k povýšení na admina.
 *
 * Celý model oprávnění jsou tři funkce:
 *
 *   requireUser()   - kdokoliv přihlášený
 *   requireAdmin()  - jen administrátor
 *   requireCaller() - jen caller, i s jeho obchodní identitou
 *
 * Víc rolí produkt nepotřebuje a obecný systém oprávnění by byl větší
 * než všechno, co chrání.
 */

export { SESSION_COOKIE };

export type { User, UserRole };

function sign(userId: string, expiresAt: number): string {
  return `${userId}.${expiresAt}.${hmacHex(env.sessionSecret, `${userId}.${expiresAt}`)}`;
}

export function createSessionToken(userId: string, now = Date.now()): string {
  return sign(userId, now + SESSION_TTL_MS);
}

/** Id uživatele z podepsané cookie, nebo null. Do databáze nesahá. */
export function readSessionUserId(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, rawExpiry] = parts;
  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  if (!safeEqual(token, sign(userId, expiresAt))) return null;
  return userId;
}

/**
 * Přihlášený uživatel, nebo null.
 *
 * Deaktivovaný účet se chová jako odhlášený: platná cookie ho nestačí
 * udržet uvnitř.
 */
export async function currentUser(): Promise<User | null> {
  const store = await cookies();
  const userId = readSessionUserId(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;
  const user = await getUser(userId);
  if (!user || !user.is_active) return null;
  return user;
}

export async function isAuthenticated(): Promise<boolean> {
  return (await currentUser()) !== null;
}

/** Kdokoliv přihlášený. Nepřihlášeného pošle na login. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Jen administrátor.
 *
 * Caller nekončí na loginu - tam už byl a je přihlášený. Dostane
 * stránku, která říká, že sem nemá přístup, a odkaz zpátky do práce.
 */
export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/nemate-pristup");
  return user;
}

/**
 * Jen caller, i s obchodní identitou.
 *
 * `caller_id` je u role caller povinné už na úrovni databáze, takže se
 * tu nedá dostat null - typ to jen zpřístupňuje volajícímu bez další
 * kontroly.
 */
export async function requireCaller(): Promise<User & { caller_id: string }> {
  const user = await requireUser();
  if (user.role !== "caller" || !user.caller_id) redirect("/nemate-pristup");
  return user as User & { caller_id: string };
}

/** Guard pro stránky a server actions. Jen přihlášení, bez ohledu na roli. */
export async function requireAuth(): Promise<User> {
  return requireUser();
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_MS / 1000,
};
