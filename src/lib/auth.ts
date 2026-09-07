import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "./env";
import { hmacHex, safeEqual } from "./crypto";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./session-cookie";

/**
 * Single-user auth: one shared password, one HMAC-signed cookie.
 * There are no accounts, roles or registration - this is an internal tool for
 * exactly one operator, and anything more would be scope the app does not need.
 */

export { SESSION_COOKIE };

function sign(expiresAt: number): string {
  return `${expiresAt}.${hmacHex(env.sessionSecret, String(expiresAt))}`;
}

export function createSessionToken(now = Date.now()): string {
  return sign(now + SESSION_TTL_MS);
}

export function verifySessionToken(token: string | undefined): boolean {
  if (!token) return false;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return false;
  const expiresAt = Number(token.slice(0, separator));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  return safeEqual(token, sign(expiresAt));
}

export function checkPassword(candidate: string): boolean {
  return safeEqual(candidate, env.appPassword);
}

export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/** Guard for server actions and pages. Redirects to /login when signed out. */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthenticated())) redirect("/login");
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_MS / 1000,
};
