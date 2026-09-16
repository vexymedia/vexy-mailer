import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { SESSION_CHECK_TIMEOUT_MS, withTimeoutOr } from "@/lib/timeout";
import { loginAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "@/components/action-form";

export const dynamic = "force-dynamic";

/**
 * Přihlášení. Dvě pole a tlačítko.
 *
 * Žádná registrace, žádný výběr role, žádné obnovení hesla: účty zakládá
 * administrátor a heslo mění taky on. Cokoliv dalšího by tuhle stránku
 * jen zdrželo.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Přihlašovací stránka se MUSÍ načíst i bez databáze.
  //
  // `isAuthenticated()` sahá na databázi, ale jen když prohlížeč posílá
  // session cookie. Bez cookie se stránka načetla vždycky; s cookie
  // čekala na databázi - a při jejím výpadku skončila chybou 500 po
  // 37 sekundách. Člověk se tak nedostal ani k formuláři, kterým by se
  // přihlásil.
  //
  // Když se do dvou sekund nedozvíme, jestli je někdo přihlášený,
  // ukážeme formulář. Přihlášený uživatel tím nic neztratí: klikne na
  // kteroukoli stránku a dostane se dál. Nepřihlášený dostane přesně to,
  // pro co přišel.
  if (await withTimeoutOr(isAuthenticated(), SESSION_CHECK_TIMEOUT_MS, false)) redirect("/");
  const { next } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-xl font-semibold tracking-tight text-zinc-900">
          Přihlášení do VEXY
        </h1>
        <p className="mb-6 text-center text-sm text-zinc-500">
          Obchodní příprava a oslovení
        </p>
        <div className="card p-6">
          <ActionForm action={loginAction}>
            <input type="hidden" name="next" value={next ?? ""} />
            <label className="label" htmlFor="email">
              E-mail
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoFocus
              autoComplete="username"
              className="input"
            />
            <label className="label mt-4" htmlFor="password">
              Heslo
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              className="input"
            />
            <SubmitButton className="btn-primary mt-5 w-full" pendingLabel="Přihlašuji…">
              Přihlásit se
            </SubmitButton>
          </ActionForm>
        </div>
      </div>
    </div>
  );
}
