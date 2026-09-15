"use client";

import { useActionState, useState } from "react";
import {
  applyExclusionImportAction,
  previewExclusionImportAction,
  type ExclusionPreviewState,
} from "@/lib/actions";
import { SubmitButton } from "./action-form";

/**
 * Import klientského vylučovacího seznamu.
 *
 * Dva kroky: nejdřív NÁHLED, teprve pak zápis. Seznam „tyhle firmy
 * neoslovovat" umí tiše vyhodit stovky leadů, takže se člověk musí
 * podívat, co se napárovalo a co ne, dřív než se cokoli uloží.
 *
 * Nejednoznačné názvy se nepřiřazují samy: dvě firmy téhož jména
 * znamenají, že se nedá říct která, a tip by tady stál platné kontakty.
 */

const KIND_LABELS: Record<string, string> = {
  matched: "Napárováno",
  already_excluded: "Už vyloučeno",
  ambiguous: "Nejednoznačné",
  not_found: "Firma nenalezena",
};

const KIND_TONE: Record<string, string> = {
  matched: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  already_excluded: "bg-zinc-100 text-zinc-600 ring-zinc-200",
  ambiguous: "bg-amber-50 text-amber-800 ring-amber-200",
  not_found: "bg-zinc-50 text-zinc-500 ring-zinc-200",
};

export function ExclusionImportForm({ clients }: { clients: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [preview, previewAction] = useActionState<ExclusionPreviewState, FormData>(
    previewExclusionImportAction,
    {},
  );
  const [applied, applyAction] = useActionState<{ error?: string; success?: string }, FormData>(
    applyExclusionImportAction,
    {},
  );

  if (clients.length === 0) return null;

  const counts = preview.matches?.reduce<Record<string, number>>((acc, m) => {
    acc[m.kind] = (acc[m.kind] ?? 0) + 1;
    return acc;
  }, {}) ?? {};

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">Import vylučovacího seznamu</h2>
        <button type="button" onClick={() => setOpen((v) => !v)} className="btn-secondary !px-2.5 !py-1 text-xs">
          {open ? "Zavřít" : "Nahrát CSV"}
        </button>
      </div>

      {open ? (
        <>
          <form action={previewAction} className="mt-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="import_client">Klient</label>
              <select id="import_client" name="client_id" required className="input w-auto text-sm">
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="min-w-56 flex-1">
              <label className="label" htmlFor="exclusion_file">Soubor</label>
              <input
                id="exclusion_file"
                name="file"
                type="file"
                accept=".csv,text/csv,text/plain"
                required
                className="input file:mr-3 file:rounded file:border-0 file:bg-zinc-100 file:px-3 file:py-1 file:text-sm"
              />
            </div>
            <SubmitButton className="btn-secondary" pendingLabel="Čtu…">Zobrazit náhled</SubmitButton>
          </form>
          <p className="hint mt-2">
            Sloupce: <code className="font-mono">ico</code> a/nebo <code className="font-mono">nazev</code>,
            volitelně <code className="font-mono">duvod</code>. Páruje se primárně podle IČO. Nic se
            neuloží, dokud náhled nepotvrdíte.
          </p>

          {preview.error ? (
            <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{preview.error}</p>
          ) : null}
          {applied.error ? (
            <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{applied.error}</p>
          ) : null}
          {applied.success ? (
            <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{applied.success}</p>
          ) : null}

          {preview.matches && preview.matches.length > 0 ? (
            <div className="mt-4 border-t border-zinc-200 pt-4">
              <div className="mb-3 flex flex-wrap gap-2 text-xs">
                {Object.entries(KIND_LABELS).map(([kind, label]) =>
                  counts[kind] ? (
                    <span key={kind} className={`badge ${KIND_TONE[kind]}`}>
                      {label}: {counts[kind]}
                    </span>
                  ) : null,
                )}
              </div>

              <div className="max-h-80 overflow-y-auto rounded-md border border-zinc-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-zinc-50 text-left text-xs text-zinc-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Řádek</th>
                      <th className="px-3 py-2 font-medium">IČO</th>
                      <th className="px-3 py-2 font-medium">Ze souboru</th>
                      <th className="px-3 py-2 font-medium">Firma v databázi</th>
                      <th className="px-3 py-2 font-medium">Výsledek</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {preview.matches.map((match) => (
                      <tr key={match.line}>
                        <td className="px-3 py-1.5 tabular-nums text-zinc-500">{match.line}</td>
                        <td className="px-3 py-1.5 tabular-nums text-zinc-700">{match.ico ?? "—"}</td>
                        <td className="px-3 py-1.5 text-zinc-700">{match.name ?? "—"}</td>
                        <td className="px-3 py-1.5 text-zinc-900">
                          {match.companyName ?? "—"}
                          {match.candidates.length > 1 ? (
                            <span className="block text-xs text-amber-700">
                              {match.candidates.length} firem stejného názvu — vyberte ručně
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-1.5">
                          <span className={`badge ${KIND_TONE[match.kind]}`}>{KIND_LABELS[match.kind]}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {counts.matched ? (
                <form action={applyAction} className="mt-3 flex flex-wrap items-center gap-3">
                  <input type="hidden" name="client_id" value={preview.clientId ?? ""} />
                  <input type="hidden" name="payload" value={JSON.stringify(preview.matches)} />
                  <SubmitButton
                    pendingLabel="Ukládám…"
                    confirm={`Vyloučit ${counts.matched} firem pro klienta ${preview.clientName}? Naplánované kroky se zruší.`}
                  >
                    Vyloučit {counts.matched} firem
                  </SubmitButton>
                  <span className="text-xs text-zinc-500">
                    Nejednoznačné a nenalezené se přeskočí — projděte je ručně.
                  </span>
                </form>
              ) : (
                <p className="mt-3 text-sm text-zinc-500">Nic jednoznačného k vyloučení.</p>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
