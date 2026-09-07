import { hmacHex, safeEqual } from "./crypto";

/**
 * Stateless one-click unsubscribe tokens.
 *
 * The token is an HMAC of the contact id, so no table of outstanding tokens is
 * needed and a link cannot be forged without the server secret.
 */

function tokenFor(contactId: string): string {
  return hmacHex(process.env.SESSION_SECRET ?? "", `unsub:${contactId}`).slice(0, 32);
}

export function appUrl(): string {
  const explicit = process.env.APP_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`;
  return "http://localhost:3000";
}

export function unsubscribeUrl(contactId: string): string {
  return `${appUrl()}/u/${contactId}/${tokenFor(contactId)}`;
}

export function verifyUnsubscribeToken(contactId: string, token: string): boolean {
  return safeEqual(token, tokenFor(contactId));
}
