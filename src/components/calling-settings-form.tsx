"use client";

import { saveCallingSettingsAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

export interface CallingSettingsValues {
  campaign_id: string;
  calling_enabled: boolean;
  max_call_attempts: number;
  script_opening: string;
  script_value: string;
  script_objections: string;
  script_closing: string;
  qualification_criteria: string;
}

/**
 * Calling configuration for one campaign: the switch, the attempt limit, the
 * script the caller reads, and the criteria that decide whether a booked
 * meeting is billable.
 */
export function CallingSettingsForm({ values }: { values: CallingSettingsValues }) {
  return (
    <ActionForm action={saveCallingSettingsAction} className="card p-6">
      <input type="hidden" name="campaign_id" value={values.campaign_id} />

      <div className="grid gap-5 sm:grid-cols-2">
        <label className="flex items-start gap-3 rounded-md border border-zinc-200 p-4">
          <input
            type="checkbox"
            name="calling_enabled"
            defaultChecked={values.calling_enabled}
            className="mt-0.5 size-4 rounded border-zinc-300"
          />
          <span>
            <span className="block text-sm font-medium text-zinc-900">Volání zapnuto</span>
            <span className="block text-xs text-zinc-500">
              Kampaň se objeví ve frontě callerů. E-mailovou sekvenci to nijak neovlivní.
            </span>
          </span>
        </label>

        <div>
          <label className="label" htmlFor="max_call_attempts">Maximální počet pokusů</label>
          <input
            id="max_call_attempts"
            name="max_call_attempts"
            type="number"
            min={1}
            max={20}
            defaultValue={values.max_call_attempts}
            required
            className="input max-w-32"
          />
          <p className="hint">
            Po vyčerpání pokusů kontakt z fronty vypadne. Domluvená schůzka ani získaný klient se
            limitem neruší.
          </p>
        </div>
      </div>

      <div className="mt-6 border-t border-zinc-200 pt-6">
        <h2 className="mb-1 text-sm font-semibold text-zinc-900">Kritéria kvalifikace</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Podle čeho caller pozná, že je schůzka kvalifikovaná. Zobrazí se přímo u zápisu schůzky a
          je to údaj, podle kterého se kampaň fakturuje.
        </p>
        <textarea
          name="qualification_criteria"
          rows={4}
          defaultValue={values.qualification_criteria}
          className="input"
          placeholder={"Rozhoduje o marketingu nebo obchodu\nFirma má 10+ zaměstnanců\nSchůzka je do 14 dnů"}
        />
      </div>

      <div className="mt-6 space-y-5 border-t border-zinc-200 pt-6">
        <h2 className="text-sm font-semibold text-zinc-900">Skript hovoru</h2>
        {(
          [
            { name: "script_opening", label: "Úvod", value: values.script_opening },
            { name: "script_value", label: "Hodnota / nabídka", value: values.script_value },
            { name: "script_objections", label: "Námitky", value: values.script_objections },
            { name: "script_closing", label: "Zakončení", value: values.script_closing },
          ] as const
        ).map((field) => (
          <div key={field.name}>
            <label className="label" htmlFor={field.name}>{field.label}</label>
            <textarea
              id={field.name}
              name={field.name}
              rows={3}
              defaultValue={field.value}
              className="input"
            />
          </div>
        ))}
      </div>

      <div className="mt-6 border-t border-zinc-200 pt-5">
        <SubmitButton pendingLabel="Ukládám…">Uložit nastavení volání</SubmitButton>
      </div>
    </ActionForm>
  );
}
