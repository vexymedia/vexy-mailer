"use client";

import { useState } from "react";
import { setCallerCampaignsAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

/**
 * Které kampaně caller zpracovává.
 *
 * Tohle je hranice mezi klienty - ne kosmetika. Caller bez přidělení
 * nedostane žádnou práci a nic cizího neuvidí, takže prázdný seznam je
 * bezpečný výchozí stav, ne chyba.
 */

export interface AssignmentOption {
  campaign_id: string;
  campaign_name: string;
  client_name: string | null;
  assigned: boolean;
}

/**
 * Řádek týmu.
 *
 * Formulář přidělení má vlastní řádek přes celou šířku tabulky - do úzké
 * buňky se nevejde a všechno kolem by se zalámalo. Proto je celý řádek
 * klientská komponenta: obě části musí sdílet jedno rozbalení.
 */
export function CallerRow({
  callerId,
  callerName,
  options,
  columns,
  actions,
  children,
}: {
  callerId: string;
  callerName: string;
  options: AssignmentOption[];
  /** Kolik sloupců má tabulka, aby rozbalený formulář sedl přes celou šířku. */
  columns: number;
  /** Ostatní akce řádku. Jsou v jedné buňce s přidělením, ať tabulka nepřeteče. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const assigned = options.filter((option) => option.assigned);

  return (
    <>
      <tr className="hover:bg-zinc-50">
        {children}
        <td className="td">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className={`!px-2 !py-1 text-xs whitespace-nowrap ${
                assigned.length === 0 ? "btn-primary" : "btn-secondary"
              }`}
            >
              {assigned.length === 0 ? "Přidělit kampaně" : `Kampaně (${assigned.length})`}
            </button>
            {actions}
          </div>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={columns} className="border-b border-zinc-100 bg-zinc-50 px-5 py-4">
            <AssignmentForm
              callerId={callerId}
              callerName={callerName}
              options={options}
              onDone={() => setOpen(false)}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function AssignmentForm({
  callerId,
  callerName,
  options,
  onDone,
}: {
  callerId: string;
  callerName: string;
  options: AssignmentOption[];
  onDone: () => void;
}) {
  return (
    <ActionForm action={setCallerCampaignsAction} className="max-w-2xl text-left">
      <input type="hidden" name="caller_id" value={callerId} />
      <p className="mb-2 text-xs text-zinc-500">
        Na čem smí <span className="font-medium text-zinc-700">{callerName}</span> pracovat.
        Nezaškrtnuté kampaně neuvidí vůbec.
      </p>

      {options.length === 0 ? (
        <p className="text-xs text-zinc-500">Zatím není žádná kampaň k přidělení.</p>
      ) : (
        <div className="grid gap-1 sm:grid-cols-2">
          {options.map((option) => (
            <label
              key={option.campaign_id}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm has-checked:border-zinc-900"
            >
              <input
                type="checkbox"
                name="campaign_ids"
                value={option.campaign_id}
                defaultChecked={option.assigned}
                className="size-4 shrink-0 border-zinc-300"
              />
              <span className="min-w-0 flex-1 truncate text-zinc-900">{option.campaign_name}</span>
              <span className="shrink-0 text-xs text-zinc-500">
                {option.client_name ?? "bez klienta"}
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <SubmitButton className="btn-primary !px-3 !py-1.5 text-sm" pendingLabel="Ukládám…">
          Uložit přidělení
        </SubmitButton>
        <button type="button" onClick={onDone} className="btn-secondary !px-3 !py-1.5 text-sm">
          Zrušit
        </button>
      </div>
    </ActionForm>
  );
}
