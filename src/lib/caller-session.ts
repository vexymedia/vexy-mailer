import { cookies } from "next/headers";
import { currentUser } from "./auth";

/**
 * Která obchodní identita zapisuje hovory na tomhle prohlížeči.
 *
 * Od zavedení uživatelských účtů je odpověď u callera daná přihlášením:
 * `users.caller_id`. Caller si tedy nevybírá, kdo je - systém to ví,
 * a proto ani nejde vydávat se za někoho jiného. Klient identitu
 * neposílá v žádné podobě.
 *
 * Cookie zůstává jen pro administrátora, který potřebuje volat pod
 * konkrétní obchodní identitou (typicky při zkoušení nebo když volá
 * sám). U callera se ignoruje - i kdyby ji někdo podstrčil.
 */
export const CALLER_COOKIE = "vexy_caller";

export async function getSelectedCallerId(): Promise<string | null> {
  const user = await currentUser();
  if (!user) return null;
  // Caller: identita z přihlášení. Nic jiného se nebere v úvahu.
  if (user.role === "caller") return user.caller_id;

  const store = await cookies();
  return store.get(CALLER_COOKIE)?.value ?? null;
}

/** Jen pro administrátora. U callera je identita daná a měnit ji nejde. */
export async function setSelectedCallerId(callerId: string): Promise<void> {
  const store = await cookies();
  store.set(CALLER_COOKIE, callerId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Pracovní den, ať se admin nemusí rozhodovat po každém hovoru.
    maxAge: 60 * 60 * 12,
  });
}

export async function clearSelectedCaller(): Promise<void> {
  const store = await cookies();
  store.delete(CALLER_COOKIE);
}
