"use client";

import { createWorkBlockAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import { ACTIVITY_TYPE_LABELS, type ActivityType } from "@/lib/plan";

/**
 * Naplánování bloku práce. Datum, čas, člověk, typ — nic víc.
 * Neplánujeme jednotlivé hovory, plánujeme kapacitu.
 */
export function WorkBlockForm({
  defaultDate,
  team,
}: {
  defaultDate: string;
  team: { id: string; name: string }[];
}) {
  return (
    <ActionForm action={createWorkBlockAction} className="card p-5">
      <h2 className="section-title mb-4">Naplánovat blok</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label className="label" htmlFor="block_date">Datum</label>
          <input id="block_date" name="block_date" type="date" defaultValue={defaultDate} required className="input" />
        </div>
        <div>
          <label className="label" htmlFor="start">Od</label>
          <input id="start" name="start" defaultValue="09:00" required className="input" placeholder="09:00" />
        </div>
        <div>
          <label className="label" htmlFor="end">Do</label>
          <input id="end" name="end" defaultValue="11:00" required className="input" placeholder="11:00" />
        </div>
        <div>
          <label className="label" htmlFor="caller_id">Kdo</label>
          <select id="caller_id" name="caller_id" className="input">
            <option value="">— nepřiřazeno —</option>
            {team.map((member) => (
              <option key={member.id} value={member.id}>{member.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="activity_type">Typ aktivity</label>
          <select id="activity_type" name="activity_type" defaultValue="calling" className="input">
            {(Object.keys(ACTIVITY_TYPE_LABELS) as ActivityType[]).map((key) => (
              <option key={key} value={key}>{ACTIVITY_TYPE_LABELS[key]}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <div className="min-w-64 flex-1">
          <label className="label" htmlFor="note">Poznámka (nepovinné)</label>
          <input id="note" name="note" className="input" placeholder="Např. follow-upy po odeslaném videu" />
        </div>
        <SubmitButton pendingLabel="Ukládám…">Přidat blok</SubmitButton>
      </div>
    </ActionForm>
  );
}
