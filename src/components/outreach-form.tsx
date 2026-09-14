"use client";

import { useState } from "react";
import { saveOutreachContextAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

/**
 * Co prospekt dostal, než mu caller zavolá.
 *
 * Vyplňuje to ten, kdo oslovení připravuje - ne caller. Caller to jen
 * čte v Oslovení a navazuje na to první větou hovoru, takže tady nesmí
 * vzniknout nic, co by se dalo napsat "od oka": buď video odešlo, nebo
 * neodešlo.
 */
export function OutreachForm({
  contactId,
  companyId,
  contactLabel,
  loomUrl,
  loomTitle,
  loomSentAt,
  loomNote,
  opener,
}: {
  contactId: string;
  companyId: string;
  contactLabel: string;
  loomUrl: string;
  loomTitle: string;
  /** Formát pro <input type="date">, tedy YYYY-MM-DD. */
  loomSentAt: string;
  loomNote: string;
  opener: string;
}) {
  const [open, setOpen] = useState(false);
  const filled = Boolean(loomUrl || opener);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary !py-1 text-xs">
        {filled ? "Upravit kontext oslovení" : "Doplnit Loom / úvodní větu"}
      </button>
    );
  }

  return (
    <ActionForm action={saveOutreachContextAction} className="mt-3 space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-4">
      <input type="hidden" name="contact_id" value={contactId} />
      <input type="hidden" name="company_id" value={companyId} />

      <p className="text-xs text-zinc-500">
        Kontext pro <span className="font-medium text-zinc-700">{contactLabel}</span>. Caller ho
        uvidí v Oslovení těsně nad tlačítkem Zavolat.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`loom_url_${contactId}`}>Odkaz na Loom</label>
          <input
            id={`loom_url_${contactId}`}
            name="loom_url"
            type="url"
            defaultValue={loomUrl}
            placeholder="https://www.loom.com/share/…"
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor={`loom_title_${contactId}`}>Název videa</label>
          <input
            id={`loom_title_${contactId}`}
            name="loom_title"
            defaultValue={loomTitle}
            placeholder="3 konkrétní příležitosti pro…"
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor={`loom_sent_${contactId}`}>Odesláno</label>
          <input
            id={`loom_sent_${contactId}`}
            name="loom_sent_at"
            type="date"
            defaultValue={loomSentAt}
            className="input"
          />
        </div>
      </div>

      <div>
        <label className="label" htmlFor={`loom_note_${contactId}`}>O čem video je</label>
        <textarea
          id={`loom_note_${contactId}`}
          name="loom_note"
          rows={2}
          defaultValue={loomNote}
          placeholder="Vojtěch ve videu ukázal…"
          className="input"
        />
        <p className="mt-1 text-xs text-zinc-500">
          Jedna dvě věty. Caller na ně navazuje, takže musí sedět.
        </p>
      </div>

      <div>
        <label className="label" htmlFor={`opener_${contactId}`}>Úvodní věta hovoru</label>
        <textarea
          id={`opener_${contactId}`}
          name="call_opener"
          rows={3}
          defaultValue={opener}
          placeholder="Dobrý den, pane Nováku, tady Jan z VEXY. Navazuji na krátké video…"
          className="input"
        />
        <p className="mt-1 text-xs text-zinc-500">
          Nepovinné. Bez ní se použije scénář kampaně, a když není ani ten, sestaví se
          bezpečná věta z toho, co prospekt opravdu dostal.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <SubmitButton pendingLabel="Ukládám…">Uložit kontext</SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className="btn-secondary">
          Zrušit
        </button>
      </div>
    </ActionForm>
  );
}
