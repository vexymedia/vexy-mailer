"use client";

import { useState } from "react";
import { scheduleNextStepAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

/**
 * "Bez dalšího kroku" je v tomhle produktu chyba, ne stav. Blok ji proto
 * nejen ukáže, ale rovnou nabídne opravu - jinak by hlášení bylo jen
 * dekorace a firma by se ztratila stejně.
 */
export function ScheduleNextStep({
  contacts,
}: {
  contacts: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);

  if (contacts.length === 0) {
    return (
      <p className="mt-2 text-xs text-zinc-500">
        Firma nemá otevřený kontakt v žádné kampani — přidejte kontakt nebo ji zařaďte do kampaně.
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-primary mt-3 w-full">
        Naplánovat
      </button>
    );
  }

  return (
    <ActionForm action={scheduleNextStepAction} className="mt-3 space-y-2">
      {contacts.length === 1 ? (
        <input type="hidden" name="campaign_contact_id" value={contacts[0].id} />
      ) : (
        <div>
          <label className="label" htmlFor="next_step_contact">Komu</label>
          <select id="next_step_contact" name="campaign_contact_id" className="input">
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label className="label" htmlFor="next_call_at">Kdy</label>
        <input
          id="next_call_at"
          name="next_call_at"
          type="datetime-local"
          defaultValue={defaultWhen()}
          required
          className="input"
        />
      </div>
      <SubmitButton className="btn-primary w-full">Naplánovat</SubmitButton>
    </ActionForm>
  );
}

/** Zítra v deset, přes víkend až v pondělí. */
function defaultWhen(): string {
  const when = new Date();
  do {
    when.setDate(when.getDate() + 1);
  } while (when.getDay() === 0 || when.getDay() === 6);
  when.setHours(10, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
