"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { logCallAction } from "@/lib/actions";
import { ActionForm } from "./action-form";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/calling";

/**
 * The caller's screen: dial, log the outcome, the next prospect loads itself.
 *
 * Two clicks per call is the design target, so an outcome button IS the submit
 * button. Only the two outcomes that need a date - a callback and a booked
 * meeting - open a second step, and a booked meeting also asks the one question
 * the whole service is billed on: does it meet the qualification criteria.
 */

export interface CallProspect {
  id: string;
  email: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  website: string | null;
  call_attempts: number;
  call_note: string | null;
  last_call_outcome: string | null;
  last_call_at: Date | null;
}

/** Value for <input type="datetime-local">, in the browser's own timezone. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function defaultCallback(): string {
  const when = new Date();
  when.setDate(when.getDate() + 1);
  when.setHours(10, 0, 0, 0);
  return toLocalInputValue(when);
}

function defaultMeeting(): string {
  const when = new Date();
  when.setDate(when.getDate() + 3);
  when.setHours(10, 0, 0, 0);
  return toLocalInputValue(when);
}

function OutcomeButtons({
  onPick,
  selected,
}: {
  onPick: (outcome: CallOutcome, requires: "callback_at" | "meeting_at" | null) => void;
  selected: CallOutcome | null;
}) {
  const { pending } = useFormStatus();
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {CALL_OUTCOMES.map((outcome) => {
        const active = selected === outcome.value;
        const twoStep = outcome.requires !== null || outcome.value === "won";
        return (
          <button
            key={outcome.value}
            type={twoStep ? "button" : "submit"}
            name={twoStep ? undefined : "outcome"}
            value={twoStep ? undefined : outcome.value}
            disabled={pending}
            onClick={() => onPick(outcome.value, outcome.requires)}
            className={`btn justify-start border text-left ${
              active
                ? "border-zinc-900 bg-zinc-900 text-white"
                : outcome.connected
                  ? "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
                  : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {outcome.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Carries the outcome as its own form value. A hidden <input name="outcome">
 * would be read first by FormData and could hold a previously clicked outcome,
 * so the button that was actually pressed is the only thing that names one.
 */
function SaveButton({ label, outcome }: { label: string; outcome: CallOutcome }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name="outcome" value={outcome} disabled={pending} className="btn-go">
      {pending ? "Ukládám…" : label}
    </button>
  );
}

export function CallWorkspace({
  prospect,
  remaining,
  maxAttempts,
  qualificationCriteria,
  callers,
}: {
  prospect: CallProspect;
  remaining: number;
  maxAttempts: number;
  qualificationCriteria: string | null;
  callers: { id: string; name: string }[];
}) {
  const [callerId, setCallerId] = useState("");
  // Outcomes that need one more piece of information before they can be saved.
  type Step = "callback_at" | "meeting_at" | "deal_value";
  const [pending, setPending] = useState<{ outcome: CallOutcome; requires: Step } | null>(null);

  // The caller picks themselves once per browser, not once per call. The id
  // is only remembered if it still names an active caller, so a retired one
  // cannot keep being attributed calls from a stale browser.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("vexy.caller_id") ?? "";
      if (callers.some((c) => c.id === stored)) setCallerId(stored);
      else if (callers.length === 1) setCallerId(callers[0].id);
    } catch {
      /* private window: the choice is simply not remembered */
    }
  }, [callers]);

  function rememberCaller(value: string) {
    setCallerId(value);
    try {
      window.localStorage.setItem("vexy.caller_id", value);
    } catch {
      /* ignore */
    }
  }

  const name = [prospect.first_name, prospect.last_name].filter(Boolean).join(" ") || prospect.email;

  return (
    <ActionForm action={logCallAction} className="space-y-4">
      <input type="hidden" name="campaign_contact_id" value={prospect.id} />
      <input type="hidden" name="caller_id" value={callerId} />

      <div className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-zinc-900">{name}</h2>
            <p className="mt-0.5 text-sm text-zinc-600">
              {prospect.company ?? "—"}
              {prospect.website ? ` · ${prospect.website}` : ""}
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">{prospect.email}</p>
          </div>
          <div className="text-right">
            <div className="text-xs text-zinc-500">
              Pokus {prospect.call_attempts + 1} z {maxAttempts} · ve frontě {remaining}
            </div>
            {prospect.phone ? (
              <a href={`tel:${prospect.phone.replace(/\s+/g, "")}`} className="btn-go mt-2 text-lg">
                VOLAT {prospect.phone}
              </a>
            ) : (
              <span className="badge mt-2 bg-amber-50 text-amber-700 ring-amber-200">bez telefonu</span>
            )}
          </div>
        </div>

        {prospect.call_note ? (
          <p className="mt-4 rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
            <span className="font-medium">Poslední poznámka:</span> {prospect.call_note}
          </p>
        ) : null}
      </div>

      <div className="card p-6">
        <h3 className="mb-3 text-sm font-semibold text-zinc-900">Zapsat výsledek</h3>
        <OutcomeButtons
          selected={pending?.outcome ?? null}
          onPick={(outcome, requires) => {
            // "won" is the one outcome the domain does not force extra input
            // for, but the deal value is what CAC and ROAS divide by, so it is
            // asked here rather than being chased up later.
            const step = requires ?? (outcome === "won" ? "deal_value" : null);
            setPending(step ? { outcome, requires: step } : null);
          }}
        />

        {pending?.requires === "callback_at" ? (
          <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 p-4">
            <label className="label" htmlFor="callback_at">Kdy zavolat znovu</label>
            <input
              id="callback_at"
              name="callback_at"
              type="datetime-local"
              defaultValue={defaultCallback()}
              required
              className="input max-w-xs"
            />
            <div className="mt-3"><SaveButton label="Uložit callback" outcome="callback" /></div>
          </div>
        ) : null}

        {pending?.requires === "meeting_at" ? (
          <div className="mt-4 space-y-3 rounded-md border border-emerald-200 bg-emerald-50/60 p-4">
            <div>
              <label className="label" htmlFor="meeting_at">Termín schůzky</label>
              <input
                id="meeting_at"
                name="meeting_at"
                type="datetime-local"
                defaultValue={defaultMeeting()}
                required
                className="input max-w-xs"
              />
            </div>
            <fieldset>
              <legend className="label">Kvalifikace schůzky</legend>
              {qualificationCriteria ? (
                <p className="mb-2 whitespace-pre-wrap text-xs text-zinc-600">{qualificationCriteria}</p>
              ) : (
                <p className="mb-2 text-xs text-zinc-500">
                  Kampaň nemá vyplněná kritéria kvalifikace — doplňte je v nastavení volání.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "yes", label: "Kvalifikovaná" },
                  { value: "no", label: "Nekvalifikovaná" },
                  { value: "", label: "Posoudit později" },
                ].map((option) => (
                  <label
                    key={option.label}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm has-checked:border-zinc-900 has-checked:bg-zinc-900 has-checked:text-white"
                  >
                    <input
                      type="radio"
                      name="meeting_qualified"
                      value={option.value}
                      defaultChecked={option.value === "yes"}
                      className="sr-only"
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <SaveButton label="Uložit schůzku" outcome="meeting_booked" />
          </div>
        ) : null}

        {pending?.requires === "deal_value" ? (
          <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50/60 p-4">
            <label className="label" htmlFor="deal_value">Hodnota obchodu v Kč (nepovinné)</label>
            <input
              id="deal_value"
              name="deal_value"
              inputMode="decimal"
              className="input max-w-xs"
              placeholder="např. 25000"
            />
            <div className="mt-3"><SaveButton label="Uložit klienta" outcome="won" /></div>
          </div>
        ) : null}

        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_200px]">
          <div>
            <label className="label" htmlFor="note">Poznámka (nepovinné)</label>
            <textarea id="note" name="note" rows={2} className="input" placeholder="Co bylo domluveno…" />
          </div>
          <div>
            <label className="label" htmlFor="caller">Kdo volá</label>
            <select
              id="caller"
              value={callerId}
              onChange={(event) => rememberCaller(event.target.value)}
              className="input"
            >
              <option value="">— nevybráno —</option>
              {callers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <p className="hint">Zapamatuje se v prohlížeči.</p>
          </div>
        </div>
      </div>
    </ActionForm>
  );
}
