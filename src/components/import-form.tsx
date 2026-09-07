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
            Import contacts from CSV
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
            Columns: <code className="font-mono">first_name, last_name, company, email, website</code>.
            Only <code className="font-mono">email</code> is required. Comma, semicolon and tab
            separators are all understood, and duplicates are skipped.
          </p>
        </div>
        <SubmitButton pendingLabel="Importing…">Import</SubmitButton>
      </div>
    </ActionForm>
  );
}
