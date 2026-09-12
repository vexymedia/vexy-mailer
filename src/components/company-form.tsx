"use client";

import { useState } from "react";
import { saveCompanyAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import {
  COMPANY_PRIORITY_LABELS,
  COMPANY_STATUS_LABELS,
  type CompanyPriority,
  type CompanyStatus,
} from "@/lib/companies";

/**
 * Kontext firmy: proč ji řešíme, jakou má prioritu, kde je a kdo ji má.
 * Tohle jsou jediná pole, která o firmě rozhoduje člověk - všechno ostatní
 * v detailu se dopočítává z historie.
 *
 * Výběrová pole jsou řízená schválně. Neřízené <select> si po uložení drží
 * původní hodnotu, protože React zachová DOM uzel a defaultValue se znovu
 * nepoužije - uživatel by pak viděl štítek "Vysoká" nad polem "Běžná".
 * Remount přes key by to sice srovnal, ale zahodil by hlášku o uložení.
 */
export function CompanyForm({
  companyId,
  reason,
  priority,
  status,
  ownerId,
  note,
  team,
}: {
  companyId: string;
  reason: string;
  priority: CompanyPriority;
  status: CompanyStatus;
  ownerId: string;
  note: string;
  team: { id: string; name: string }[];
}) {
  const [priorityValue, setPriorityValue] = useState(priority);
  const [statusValue, setStatusValue] = useState(status);
  const [ownerValue, setOwnerValue] = useState(ownerId);

  return (
    <ActionForm action={saveCompanyAction} className="card p-5">
      <input type="hidden" name="company_id" value={companyId} />

      <div>
        <label className="label" htmlFor="reason">Proč ji řešíme</label>
        <textarea
          id="reason"
          name="reason"
          rows={3}
          defaultValue={reason}
          className="input"
          placeholder="Např. výrobní firma 20-50 zaměstnanců, expanduje, nemá vlastní obchodní tým"
        />
        <p className="hint">Krátce a konkrétně. Tohle čte caller těsně před hovorem.</p>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="priority">Priorita</label>
          <select
            id="priority"
            name="priority"
            value={priorityValue}
            onChange={(event) => setPriorityValue(event.target.value as CompanyPriority)}
            className="input"
          >
            {(Object.keys(COMPANY_PRIORITY_LABELS) as CompanyPriority[]).map((key) => (
              <option key={key} value={key}>{COMPANY_PRIORITY_LABELS[key]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="status">Stav</label>
          <select
            id="status"
            name="status"
            value={statusValue}
            onChange={(event) => setStatusValue(event.target.value as CompanyStatus)}
            className="input"
          >
            {(Object.keys(COMPANY_STATUS_LABELS) as CompanyStatus[]).map((key) => (
              <option key={key} value={key}>{COMPANY_STATUS_LABELS[key]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="owner_id">Odpovědná osoba</label>
          <select
            id="owner_id"
            name="owner_id"
            value={ownerValue}
            onChange={(event) => setOwnerValue(event.target.value)}
            className="input"
          >
            <option value="">— nepřiřazeno —</option>
            {team.map((member) => (
              <option key={member.id} value={member.id}>{member.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-5">
        <label className="label" htmlFor="note">Poznámka</label>
        <textarea id="note" name="note" rows={2} defaultValue={note} className="input" />
      </div>

      <div className="mt-5 border-t border-zinc-200 pt-4">
        <SubmitButton pendingLabel="Ukládám…">Uložit</SubmitButton>
      </div>
    </ActionForm>
  );
}
