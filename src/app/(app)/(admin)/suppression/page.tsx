import Link from "next/link";
import {
  auditSuppression,
  listClientExclusions,
  listSuppression,
  SAFE_TO_RESTORE,
} from "@/lib/queries/suppression";
import { restoreSuppressedAction, suppressEmailAction, unsuppressEmailAction } from "@/lib/actions";
import { PageHeader, Table, DateTime, EmptyState } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { NastaveniTabs } from "@/components/section-tabs";

export const dynamic = "force-dynamic";

/**
 * Nekontaktovat.
 *
 * Obrazovka se dřív jmenovala „Vyloučené firmy“ a obsahovala e-mailové
 * adresy - dva různé pojmy pod jedním názvem. Teď jsou to čtyři pohledy
 * na čtyři skutečně různé věci:
 *
 *   Kontakty          globální blok konkrétní adresy
 *   Klientská vyloučení  firma vyloučená pro JEDNOHO klienta
 *   Ke kontrole       starší záznamy bez zjistitelného důvodu
 *   Audit             co je v seznamu a co z toho jde bezpečně vrátit
 *
 * Důvod se ukazuje česky. Interní enum (`unsubscribe_link`) zůstává
 * v databázi, kde patří.
 */

const VIEWS = [
  { key: "kontakty", label: "Kontakty" },
  { key: "klienti", label: "Klientská vyloučení" },
  { key: "kontrola", label: "Ke kontrole" },
  { key: "audit", label: "Audit" },
] as const;

type View = (typeof VIEWS)[number]["key"];

export default async function SuppressionPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const params = await searchParams;
  const view = (VIEWS.find((v) => v.key === params.view)?.key ?? "kontakty") as View;

  return (
    <>
      <PageHeader title="Nekontaktovat" />
      <NastaveniTabs active={"/suppression"} />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => (
          <Link
            key={v.key}
            href={v.key === "kontakty" ? "/suppression" : `/suppression?view=${v.key}`}
            className={`rounded-md px-3 py-1.5 text-sm ${
              view === v.key
                ? "bg-zinc-900 font-medium text-white"
                : "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50"
            }`}
          >
            {v.label}
          </Link>
        ))}
      </div>

      {view === "kontakty" ? <ContactsView /> : null}
      {view === "klienti" ? <ClientsView /> : null}
      {view === "kontrola" ? <ReviewView /> : null}
      {view === "audit" ? <AuditView /> : null}
    </>
  );
}

async function ContactsView() {
  const rows = await listSuppression("all");

  return (
    <>
      <div className="mb-6 max-w-xl">
        <ActionForm action={suppressEmailAction} className="card p-5">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex-1">
              <label className="label" htmlFor="email">Přidat adresu</label>
              <input id="email" name="email" type="email" required className="input" placeholder="někdo@firma.cz" />
            </div>
            <input type="hidden" name="reason" value="manual" />
            <SubmitButton pendingLabel="Přidávám…">Přidat</SubmitButton>
          </div>
        </ActionForm>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Seznam je prázdný" description="Nikdo zatím není zablokovaný." />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">E-mail</th>
              <th className="th">Rozsah</th>
              <th className="th">Důvod</th>
              <th className="th">Přidáno</th>
              <th className="th"></th>
            </tr>
          }
        >
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="td font-medium text-zinc-900">{row.email}</td>
              <td className="td text-sm text-zinc-600">Globálně</td>
              <td className="td text-sm">
                {row.label}
                {row.note ? <div className="text-xs text-zinc-500">{row.note}</div> : null}
              </td>
              <td className="td text-xs"><DateTime value={row.created_at} /></td>
              <td className="td text-right">
                {row.restorable ? (
                  <ActionForm action={unsuppressEmailAction} hideMessages>
                    <input type="hidden" name="email" value={row.email} />
                    <SubmitButton
                      className="btn-secondary !px-2 !py-1 text-xs"
                      confirm={`Odebrat ${row.email}? Adresa půjde znovu kontaktovat.`}
                    >
                      Odebrat
                    </SubmitButton>
                  </ActionForm>
                ) : (
                  <span className="text-xs text-zinc-400" title="Odhlášení a stížnosti na spam se nevrací.">
                    trvale
                  </span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}

async function ClientsView() {
  const rows = await listClientExclusions();
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Žádná klientská vyloučení"
        description="Firma vyloučená pro jednoho klienta zůstává k oslovení pro ostatní. Vyloučení se zakládá na detailu firmy."
      />
    );
  }
  return (
    <Table
      head={
        <tr>
          <th className="th">Firma</th>
          <th className="th">Klient</th>
          <th className="th">Důvod</th>
          <th className="th">Přidáno</th>
        </tr>
      }
    >
      {rows.map((row) => (
        <tr key={row.id}>
          <td className="td">
            <Link href={`/firmy/${row.company_id}`} className="font-medium text-zinc-900 hover:underline">
              {row.company_name}
            </Link>
          </td>
          <td className="td text-sm">{row.client_name}</td>
          <td className="td text-sm text-zinc-600">{row.reason ?? "—"}</td>
          <td className="td text-xs"><DateTime value={row.created_at} /></td>
        </tr>
      ))}
    </Table>
  );
}

async function ReviewView() {
  const rows = await listSuppression("review");
  if (rows.length === 0) {
    return <EmptyState title="Nic ke kontrole" description="Všechny záznamy mají zjistitelný důvod." />;
  }
  return (
    <>
      <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        Tyhle adresy mají v databázi důvod, kterému se nedá věřit. Automaticky se nevrací —
        projděte je a rozhodněte jednu po druhé.
      </p>
      <Table
        head={
          <tr>
            <th className="th">E-mail</th>
            <th className="th">Původní důvod</th>
            <th className="th">Přidáno</th>
            <th className="th"></th>
          </tr>
        }
      >
        {rows.map((row) => (
          <tr key={row.id}>
            <td className="td font-medium text-zinc-900">{row.email}</td>
            <td className="td text-sm text-zinc-600">{row.note ?? row.source ?? "neuvedeno"}</td>
            <td className="td text-xs"><DateTime value={row.created_at} /></td>
            <td className="td text-right">
              <ActionForm action={unsuppressEmailAction} hideMessages>
                <input type="hidden" name="email" value={row.email} />
                <SubmitButton
                  className="btn-secondary !px-2 !py-1 text-xs"
                  confirm={`Vrátit ${row.email} do oběhu?`}
                >
                  Vrátit
                </SubmitButton>
              </ActionForm>
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}

async function AuditView() {
  const groups = await auditSuppression();
  if (groups.length === 0) {
    return <EmptyState title="Seznam je prázdný" description="Není co auditovat." />;
  }
  return (
    <>
      <p className="mb-4 text-sm text-zinc-600">
        Přehled je jen čtení. Nic se nemění, dokud sami nespustíte obnovení.
      </p>
      <Table
        head={
          <tr>
            <th className="th">Důvod</th>
            <th className="th">Zdroj</th>
            <th className="th text-right">Počet</th>
            <th className="th">Nejstarší</th>
            <th className="th">Nález</th>
            <th className="th"></th>
          </tr>
        }
      >
        {groups.map((group) => (
          <tr key={`${group.reason_code}-${group.source ?? "none"}`}>
            <td className="td font-medium text-zinc-900">{group.label}</td>
            <td className="td text-xs text-zinc-500">{group.source ?? "—"}</td>
            <td className="td text-right tabular-nums">{group.count}</td>
            <td className="td text-xs"><DateTime value={group.oldest} /></td>
            <td className="td text-sm">
              {group.disposition === "keep" ? (
                <span className="badge bg-zinc-100 text-zinc-700 ring-zinc-200">zůstává trvale</span>
              ) : group.disposition === "restorable" ? (
                <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">
                  jde bezpečně vrátit
                </span>
              ) : (
                <span className="badge bg-amber-50 text-amber-700 ring-amber-200">ke kontrole</span>
              )}
            </td>
            <td className="td text-right">
              {SAFE_TO_RESTORE.includes(group.reason_code) ? (
                <ActionForm action={restoreSuppressedAction} hideMessages>
                  <input type="hidden" name="reason_code" value={group.reason_code} />
                  <SubmitButton
                    className="btn-secondary !px-2 !py-1 text-xs"
                    confirm={`Vrátit ${group.count} adres do oběhu? Byly zablokované technickou chybou doručení, ne rozhodnutím příjemce.`}
                  >
                    Vrátit všechny
                  </SubmitButton>
                </ActionForm>
              ) : null}
            </td>
          </tr>
        ))}
      </Table>
    </>
  );
}
