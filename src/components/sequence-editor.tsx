"use client";

import { useState } from "react";
import { saveStepsAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import { TEMPLATE_VARIABLES, findUnknownVariables } from "@/lib/template";

export interface StepValues {
  step_number: number;
  delay_days: number;
  subject: string;
  body: string;
  /** Steps that have already been sent cannot be removed. */
  locked: boolean;
}

const BLANK: StepValues = { step_number: 0, delay_days: 3, subject: "", body: "", locked: false };

/**
 * Fully controlled on purpose. With uncontrolled inputs, the server re-render
 * that follows a save resets each field to its `defaultValue` - silently
 * discarding whatever was typed into a step added in the browser. Holding the
 * text in React state makes the form survive revalidation.
 */
export function SequenceEditor({
  campaignId,
  initialSteps,
  readOnly,
}: {
  campaignId: string;
  initialSteps: StepValues[];
  readOnly: boolean;
}) {
  const [steps, setSteps] = useState<StepValues[]>(
    initialSteps.length > 0 ? initialSteps : [{ ...BLANK, step_number: 1, delay_days: 0 }],
  );

  function update(index: number, patch: Partial<StepValues>) {
    setSteps((current) => current.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  }

  // Live feedback on typos, rather than waiting for the server to reject them.
  const unknownVariables = [
    ...new Set(steps.flatMap((step) => [...findUnknownVariables(step.subject), ...findUnknownVariables(step.body)])),
  ];

  return (
    <ActionForm action={saveStepsAction}>
      <input type="hidden" name="campaign_id" value={campaignId} />
      <input type="hidden" name="step_count" value={steps.length} />

      <div className="mb-4 rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
        Proměnné:{" "}
        {TEMPLATE_VARIABLES.map((variable) => (
          <code key={variable} className="mx-1 rounded bg-white px-1.5 py-0.5 font-mono text-xs ring-1 ring-zinc-200">
            {`{{${variable}}}`}
          </code>
        ))}
        <br />
        <span className="text-xs">
          Hodnota za svislítkem se použije, když údaj chybí:{" "}
          <code className="font-mono">{"{{first_name|there}}"}</code>
        </span>
      </div>

      {unknownVariables.length > 0 ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Neznámé proměnné: {unknownVariables.map((name) => `{{${name}}}`).join(", ")}. Vykreslily by
          se jako prázdný text.
        </div>
      ) : null}

      <div className="space-y-4">
        {steps.map((step, index) => (
          <div key={index} className="card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-zinc-900">
                {index === 0 ? "E-mail 1" : `Follow-up ${index}`}
                {step.locked ? (
                  <span className="ml-2 text-xs font-normal text-zinc-500">
                    (už odesláno — nelze smazat)
                  </span>
                ) : null}
              </h3>
              <div className="flex items-center gap-2">
                <label className="text-sm text-zinc-600" htmlFor={`step_${index}_delay`}>
                  {index === 0 ? "Odesláno v den" : "Čekat od předchozího"}
                </label>
                <input
                  id={`step_${index}_delay`}
                  name={`step_${index}_delay`}
                  type="number"
                  min={0}
                  max={365}
                  value={index === 0 ? 0 : step.delay_days}
                  onChange={(event) => update(index, { delay_days: Number(event.target.value) })}
                  readOnly={index === 0 || readOnly}
                  className="input w-20 text-center"
                />
                <span className="text-sm text-zinc-500">dnů</span>
                {/* The first email cannot be removed: promoting a follow-up in its
                    place would leave step 1 with a non-zero delay, which is invalid. */}
                {index > 0 && !step.locked && !readOnly ? (
                  <button
                    type="button"
                    onClick={() => setSteps(steps.filter((_, i) => i !== index))}
                    className="btn-danger ml-2"
                  >
                    Smazat
                  </button>
                ) : null}
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="label" htmlFor={`step_${index}_subject`}>Předmět</label>
                <input
                  id={`step_${index}_subject`}
                  name={`step_${index}_subject`}
                  value={step.subject}
                  onChange={(event) => update(index, { subject: event.target.value })}
                  disabled={readOnly}
                  className="input"
                  placeholder="Krátký dotaz ohledně {{company}}"
                />
              </div>
              <div>
                <label className="label" htmlFor={`step_${index}_body`}>Text</label>
                <textarea
                  id={`step_${index}_body`}
                  name={`step_${index}_body`}
                  value={step.body}
                  onChange={(event) => update(index, { body: event.target.value })}
                  disabled={readOnly}
                  rows={9}
                  className="input font-mono text-[13px] leading-relaxed"
                  placeholder={"Ahoj {{first_name|there}},\n\nnarazil jsem na {{company}}…"}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {!readOnly ? (
        <div className="mt-5 flex items-center gap-3">
          <SubmitButton pendingLabel="Ukládám…">Uložit sekvenci</SubmitButton>
          <button
            type="button"
            onClick={() => setSteps([...steps, { ...BLANK, step_number: steps.length + 1 }])}
            className="btn-secondary"
          >
            Přidat follow-up
          </button>
        </div>
      ) : (
        <p className="mt-5 text-sm text-zinc-500">Pro úpravu sekvence kampaň pozastavte.</p>
      )}
    </ActionForm>
  );
}
