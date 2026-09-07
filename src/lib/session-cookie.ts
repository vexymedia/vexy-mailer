/**
 * Edge-safe constants. Kept apart from auth.ts because middleware runs on the
 * Edge runtime, where importing node:crypto (which auth.ts needs) fails to
 * bundle.
 */
export const SESSION_COOKIE = "vexy_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
