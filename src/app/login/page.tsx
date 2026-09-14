import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
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
  if (await isAuthenticated()) redirect("/");
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
