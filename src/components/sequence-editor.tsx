"use client";

import { useState } from "react";
import { saveStepsAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import { TEMPLATE_VARIABLES } from "@/lib/template";

export interface StepValues {
  step_number: number;
  delay_days: number;
  subject: string;
  body: string;
  /** Steps that have already been sent cannot be removed. */
  locked: boolean;
}

const BLANK: StepValues = { step_number: 0, delay_days: 3, subject: "", body: "", locked: false };

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
    initialSteps.length > 0
      ? initialSteps
      : [{ ...BLANK, step_number: 1, delay_days: 0, subject: "", body: "" }],
  );

  return (
    <ActionForm action={saveStepsAction}>
      <input type="hidden" name="campaign_id" value={campaignId} />
      <input type="hidden" name="step_count" value={steps.length} />

      <div className="mb-4 rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600">
        Variables:{" "}
        {TEMPLATE_VARIABLES.map((variable) => (
          <code key={variable} className="mx-1 rounded bg-white px-1.5 py-0.5 font-mono text-xs ring-1 ring-zinc-200">
            {`{{${variable}}}`}
          </code>
        ))}
        <br />
        <span className="text-xs">
          A fallback after a pipe is used when the value is missing:{" "}
          <code className="font-mono">{"{{first_name|there}}"}</code>
        </span>
      </div>

      <div className="space-y-4">
        {steps.map((step, index) => (
          <div key={index} className="card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-zinc-900">
                {index === 0 ? "Email 1" : `Follow-up ${index}`}
                {step.locked ? (
                  <span className="ml-2 text-xs font-normal text-zinc-500">(already sent — cannot be removed)</span>
                ) : null}
              </h3>
              <div className="flex items-center gap-2">
                <label className="text-sm text-zinc-600" htmlFor={`step_${index}_delay`}>
                  {index === 0 ? "Sent on day" : "Wait after previous"}
                </label>
                <input
                  id={`step_${index}_delay`}
                  name={`step_${index}_delay`}
                  type="number"
                  min={0}
                  max={365}
                  defaultValue={index === 0 ? 0 : step.delay_days}
                  readOnly={index === 0 || readOnly}
                  className="input w-20 text-center"
                />
                <span className="text-sm text-zinc-500">days</span>
                {!step.locked && steps.length > 1 && !readOnly ? (
                  <button
                    type="button"
                    onClick={() => setSteps(steps.filter((_, i) => i !== index))}
                    className="btn-danger ml-2"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="label" htmlFor={`step_${index}_subject`}>Subject</label>
                <input
                  id={`step_${index}_subject`}
                  name={`step_${index}_subject`}
                  defaultValue={step.subject}
                  disabled={readOnly}
                  className="input"
                  placeholder="Quick question about {{company}}"
                />
              </div>
              <div>
                <label className="label" htmlFor={`step_${index}_body`}>Body</label>
                <textarea
                  id={`step_${index}_body`}
                  name={`step_${index}_body`}
                  defaultValue={step.body}
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
          <SubmitButton pendingLabel="Saving…">Save sequence</SubmitButton>
          <button
            type="button"
            onClick={() => setSteps([...steps, { ...BLANK, step_number: steps.length + 1 }])}
            className="btn-secondary"
          >
            Add follow-up
          </button>
        </div>
      ) : (
        <p className="mt-5 text-sm text-zinc-500">
          Pause the campaign to edit the sequence.
        </p>
      )}
    </ActionForm>
  );
}
