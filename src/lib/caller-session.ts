import { cookies } from "next/headers";

/**
 * Which caller is at this browser.
 *
 * Held server-side in a cookie rather than in localStorage, for two reasons.
 * The page has to know the caller while it renders, because that is when the
 * next prospect is leased and a lease needs an owner; and an outcome must be
 * attributed to whoever is actually signed in at this workstation, not to
 * whatever a form field happens to carry.
 */
export const CALLER_COOKIE = "vexy_caller";

export async function getSelectedCallerId(): Promise<string | null> {
  const store = await cookies();
  return store.get(CALLER_COOKIE)?.value ?? null;
}

export async function setSelectedCallerId(callerId: string): Promise<void> {
  const store = await cookies();
  store.set(CALLER_COOKIE, callerId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // A working day, so a caller picks themselves once per shift.
    maxAge: 60 * 60 * 12,
  });
}

export async function clearSelectedCaller(): Promise<void> {
  const store = await cookies();
  store.delete(CALLER_COOKIE);
}
