"use client";

import { importContactsAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

export function ImportForm({ campaignId }: { campaignId?: string }) {
  return (
    <ActionForm action={importContactsAction} className="card p-5">
      {campaignId ? <input type="hidden" name="campaign_id" value={campaignId} /> : null}
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-64 flex-1">
          <label className="label" htmlFor="file">
            Import kontaktů z CSV
          </label>
          <input
            id="file"
            name="file"
            type="file"
            accept=".csv,text/csv,text/plain"
            required
            className="input file:mr-3 file:rounded file:border-0 file:bg-zinc-100 file:px-3 file:py-1 file:text-sm"
          />
          <p className="hint">
            Sloupce: <code className="font-mono">first_name, last_name, company, email, website, phone</code>.
            Povinný je jen <code className="font-mono">email</code>; <code className="font-mono">phone</code> je
            potřeba pro volání. Rozpozná se čárka, středník i tabulátor a duplicity se přeskočí.
          </p>
        </div>
        <SubmitButton pendingLabel="Importuji…">Importovat</SubmitButton>
      </div>
    </ActionForm>
  );
}
