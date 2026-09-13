"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "./action-form";
import { createCompanyAction } from "@/lib/actions";
import { COMPANY_PRIORITY_LABELS, type CompanyPriority } from "@/lib/companies";

/**
 * Ruční založení firmy.
 *
 * Schválně jen čtyři pole. Tohle není správa firem, ale "za dvě minuty
 * mám hovor a potřebuju tu firmu mít v systému".
 */
export function CompanyCreateForm() {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-primary">
        Přidat firmu
      </button>
    );
  }

  return (
    <ActionForm action={createCompanyAction} className="card w-full max-w-xl p-5">
      <h2 className="mb-4 text-sm font-semibold text-zinc-900">Nová firma</h2>

      <div className="space-y-4">
        <div>
          <label className="label" htmlFor="company_name">Název firmy</label>
          <input id="company_name" name="name" required autoFocus className="input" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="company_website">Web</label>
            <input id="company_website" name="website" className="input" placeholder="acme.cz" />
          </div>
          <div>
            <label className="label" htmlFor="company_priority">Priorita</label>
            <select id="company_priority" name="priority" defaultValue="normal" className="input">
              {(Object.keys(COMPANY_PRIORITY_LABELS) as CompanyPriority[]).map((key) => (
                <option key={key} value={key}>{COMPANY_PRIORITY_LABELS[key]}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="company_reason">Proč ji řešíme</label>
          <textarea
            id="company_reason"
            name="reason"
            rows={2}
            className="input"
            placeholder="Např. výrobní firma, expanduje, nemá vlastní obchodní tým"
          />
          <p className="hint">Tohle čte caller těsně před hovorem.</p>
        </div>
      </div>

      <div className="mt-5 flex items-center gap-2 border-t border-zinc-200 pt-4">
        <SubmitButton pendingLabel="Zakládám…">Založit firmu</SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className="btn-secondary">
          Zrušit
        </button>
      </div>
    </ActionForm>
  );
}
