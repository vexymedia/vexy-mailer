import { sql } from "@/lib/db";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import { suppressEmail } from "@/lib/queries/contacts";

export const dynamic = "force-dynamic";

/**
 * Public one-click unsubscribe. Reached from the List-Unsubscribe header and
 * the {{unsubscribe_link}} variable. No session required - the HMAC in the URL
 * is the authorisation.
 *
 * This is a route handler rather than a page so that reading the URL and
 * acting on it are different requests:
 *
 *   GET / HEAD  render a confirmation page and change nothing
 *   POST        perform the unsubscribe
 *
 * That split is the whole point. A server-component page mutates while it
 * renders, so every corporate link scanner, Safe Links rewrite, spam filter
 * and mail-client prefetch that follows a URL in an email would silently
 * unsubscribe the recipient - the contact never clicked anything. GET and HEAD
 * are defined as safe methods precisely because those crawlers assume it, and
 * RFC 8058 says the same thing for this URL specifically: the one-click
 * mechanism POSTs, and the address must not be removed on a mere retrieval.
 */

const STYLE = `
  :root { color-scheme: light }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#fafafa; color:#18181b; padding:1rem;
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif }
  .card { max-width:28rem; width:100%; box-sizing:border-box; background:#fff; border:1px solid #e4e4e7;
          border-radius:.75rem; padding:2rem; text-align:center;
          box-shadow:0 1px 2px rgba(0,0,0,.05) }
  h1 { margin:0; font-size:1.125rem; font-weight:600 }
  p { margin:.5rem 0 0; color:#52525b }
  form { margin:1.5rem 0 0 }
  button { font:inherit; font-weight:500; cursor:pointer; border:0; border-radius:.5rem;
           padding:.625rem 1.25rem; background:#18181b; color:#fff }
  button:hover { background:#3f3f46 }
`;

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/**
 * The one page in the app rendered without the Next layout, so it carries its
 * own markup and styles. Czech like the rest of the UI: the people who reach it
 * are the prospects, not the operator.
 */
function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html><html lang="cs"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex,nofollow">` +
      `<title>${title}</title><style>${STYLE}</style></head>` +
      `<body><div class="card"><h1>${title}</h1>${body}</div></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Nothing here may be cached or indexed: the page is per-recipient and
        // the POST target must always be revalidated.
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    },
  );
}

const invalid = () => page("Neplatný odkaz", `<p>Tento odhlašovací odkaz není platný.</p>`, 400);

/** Resolves the contact behind the URL, or null if the link does not check out. */
async function resolveContact(id: string, token: string): Promise<string | null> {
  if (!verifyUnsubscribeToken(id, token)) return null;
  const [contact] = await sql<{ email: string }[]>`select email from contacts where id = ${id}`;
  return contact?.email ?? null;
}

type Context = { params: Promise<{ id: string; token: string }> };

/**
 * Safe. Renders the confirmation form and touches no state, so a scanner
 * following this link costs us nothing. HEAD is served from this handler too,
 * with the body discarded, and is safe for the same reason.
 */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const { id, token } = await params;
  const email = await resolveContact(id, token);
  if (!email) return invalid();

  return page(
    "Odhlášení z odběru",
    `<p>Potvrďte, že adresa <strong>${escapeHtml(email)}</strong> už od nás nemá dostávat e-maily.</p>` +
      `<form method="post"><button type="submit">Odhlásit mě</button></form>`,
    200,
  );
}

/**
 * The mutation. Reached either from the button above or from a mail client's
 * RFC 8058 one-click POST, which sends `List-Unsubscribe=One-Click` as the
 * body. Both are deliberate acts by the recipient, so neither needs to be
 * distinguished from the other. Repeating it is harmless - suppression is an
 * upsert.
 */
export async function POST(_request: Request, { params }: Context): Promise<Response> {
  const { id, token } = await params;
  const email = await resolveContact(id, token);
  if (!email) return invalid();

  await suppressEmail(email, "unsubscribe_link");

  return page(
    "Odhlášeno",
    `<p>${escapeHtml(email)} byl odebrán. Další e-maily od nás už nedostanete.</p>`,
    200,
  );
}
