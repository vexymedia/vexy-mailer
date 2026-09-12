import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import { loginAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "@/components/action-form";

export const dynamic = "force-dynamic";

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
          vexy<span className="text-zinc-400">-mailer</span>
        </h1>
        <p className="mb-6 text-center text-sm text-zinc-500">Interní nástroj pro outreach a volání</p>
        <div className="card p-6">
          <ActionForm action={loginAction}>
            <input type="hidden" name="next" value={next ?? "/"} />
            <label className="label" htmlFor="password">
              Heslo
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoFocus
              autoComplete="current-password"
              className="input"
            />
            <SubmitButton className="btn-primary mt-4 w-full" pendingLabel="Přihlašuji…">
              Přihlásit
            </SubmitButton>
          </ActionForm>
        </div>
      </div>
    </div>
  );
}
