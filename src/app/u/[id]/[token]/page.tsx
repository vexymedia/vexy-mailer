import { sql } from "@/lib/db";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import { suppressEmail } from "@/lib/queries/contacts";

export const dynamic = "force-dynamic";

/**
 * Public one-click unsubscribe. Reached from the List-Unsubscribe header and
 * the {{unsubscribe_link}} variable. No session required - the HMAC in the URL
 * is the authorisation.
 */
export default async function UnsubscribePage({
  params,
}: {
  params: Promise<{ id: string; token: string }>;
}) {
  const { id, token } = await params;
  let message = "This unsubscribe link is not valid.";
  let ok = false;

  if (verifyUnsubscribeToken(id, token)) {
    const [contact] = await sql<{ email: string }[]>`select email from contacts where id = ${id}`;
    if (contact) {
      await suppressEmail(contact.email, "unsubscribe_link");
      message = `${contact.email} has been removed. You will not receive any further emails from us.`;
      ok = true;
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card max-w-md p-8 text-center">
        <h1 className="text-lg font-semibold text-zinc-900">
          {ok ? "Unsubscribed" : "Link not valid"}
        </h1>
        <p className="mt-2 text-sm text-zinc-600">{message}</p>
      </div>
    </div>
  );
}
