import Link from "next/link";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Kam se dostane caller, který si zkusil otevřít administraci.
 *
 * Není to chybová stránka: nic se nepokazilo, jen tam nemá co dělat.
 * Proto vede jedno tlačítko rovnou zpátky do práce.
 */
export default async function NoAccessPage() {
  const user = await requireUser();
  const home = user.role === "caller" ? "/osloveni" : "/";

  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
        K této části nemáte přístup.
      </h1>
      <p className="mt-2 text-sm text-zinc-600">
        Tahle stránka patří administrátorovi. Vaše práce je v Oslovení.
      </p>
      <Link href={home} className="btn-go mt-6 inline-block">
        Zpátky do práce
      </Link>
    </div>
  );
}
