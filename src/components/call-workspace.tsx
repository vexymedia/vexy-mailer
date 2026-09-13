"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { logCallAction } from "@/lib/actions";
import { ActionForm } from "./action-form";
import {
  PRIMARY_CALL_OUTCOMES,
  SECONDARY_CALL_OUTCOMES,
  type CallOutcome,
  type CallOutcomeDefinition,
} from "@/lib/calling";

/**
 * Pracovní režim: jedna firma, jeden hovor, jeden výsledek, další firma.
 *
 * Cíl jsou dva kliky na hovor, takže tlačítko výsledku JE odesílací tlačítko.
 * Druhý krok mají jen výsledky, které se bez údaje nedají uložit - callback,
 * schůzka (a u ní otázka, na které stojí fakturace: splňuje kritéria?) a
 * získaný klient s hodnotou obchodu.
 */

export interface CallProspect {
  id: string;
  email: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  company: string | null;
  website: string | null;
  call_attempts: number;
  call_note: string | null;
  last_call_outcome: string | null;
  last_call_at: Date | null;
}

export interface CallBriefing {
  /** Název firmy, pokud ho známe lépe než z textu na kontaktu. */
  companyName: string | null;
  reason: string | null;
  priorityLabel: string | null;
  priority: string | null;
  statusLabel: string | null;
  companyHref: string | null;
  campaignName: string | null;
  /** Předformátovaný další krok, např. "Dnes 10:30". */
  nextStep: string | null;
  nextStepOverdue?: boolean;
  /** Poslední dvě až tři události, už naformátované na serveru. */
  recent: { id: string; when: string; text: string }[];
}

/** Value for <input type="datetime-local">, in the browser's own timezone. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Zítra v deset, ale přes víkend se nevolá - tak jako kadence na serveru. */
function defaultCallback(): string {
  const when = new Date();
  do {
    when.setDate(when.getDate() + 1);
  } while (when.getDay() === 0 || when.getDay() === 6);
  when.setHours(10, 0, 0, 0);
  return toLocalInputValue(when);
}

function defaultMeeting(): string {
  const when = new Date();
  let added = 0;
  while (added < 3) {
    when.setDate(when.getDate() + 1);
    if (when.getDay() !== 0 && when.getDay() !== 6) added++;
  }
  when.setHours(10, 0, 0, 0);
  return toLocalInputValue(when);
}

function OutcomeButton({
  outcome,
  active,
  onPick,
  tone,
}: {
  outcome: CallOutcomeDefinition;
  active: boolean;
  onPick: (outcome: CallOutcome, requires: "callback_at" | "meeting_at" | null) => void;
  tone: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();
  const twoStep = outcome.requires !== null || outcome.value === "won";
  const base =
    tone === "primary"
      ? "border-zinc-300 bg-white text-zinc-900 hover:border-zinc-400 hover:bg-zinc-50"
      : "border-zinc-200 bg-zinc-50 text-zinc-600 hover:bg-zinc-100";
  return (
    <button
      type={twoStep ? "button" : "submit"}
      name={twoStep ? undefined : "outcome"}
      value={twoStep ? undefined : outcome.value}
      disabled={pending}
      onClick={() => onPick(outcome.value, outcome.requires)}
      className={`btn justify-start border text-left ${
        active ? "border-zinc-900 bg-zinc-900 text-white" : base
      }`}
    >
      {outcome.label}
    </button>
  );
}

function MoreOutcomesButton({ onClick }: { onClick: () => void }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="btn justify-start border border-dashed border-zinc-300 text-left text-zinc-500 hover:bg-zinc-50"
    >
      Další výsledky…
    </button>
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

function Chip({ children, tone = "zinc" }: { children: React.ReactNode; tone?: "zinc" | "amber" | "emerald" | "red" }) {
  const styles = {
    zinc: "bg-zinc-100 text-zinc-700 ring-zinc-200",
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    red: "bg-red-50 text-red-700 ring-red-200",
  }[tone];
  return <span className={`badge ${styles}`}>{children}</span>;
}

export function CallWorkspace({
  prospect,
  remaining,
  maxAttempts,
  qualificationCriteria,
  callerName,
  campaignScope = "",
  mode = null,
  briefing,
}: {
  prospect: CallProspect;
  remaining: number;
  maxAttempts: number;
  qualificationCriteria: string | null;
  callerName: string;
  /** Prázdné = po zápisu se bere další kontakt napříč kampaněmi. */
  campaignScope?: string;
  /** Pracovní režim z plánu: první oslovení, nebo follow-up. */
  mode?: "first" | "followup" | null;
  briefing?: CallBriefing;
}) {
  // Outcomes that need one more piece of information before they can be saved.
  type Step = "callback_at" | "meeting_at" | "deal_value";
  const [pending, setPending] = useState<{ outcome: CallOutcome; requires: Step } | null>(null);
  const [showAllOutcomes, setShowAllOutcomes] = useState(false);

  const name = [prospect.first_name, prospect.last_name].filter(Boolean).join(" ") || prospect.email;
  const companyName = briefing?.companyName ?? prospect.company ?? "—";
  const tel = prospect.phone?.replace(/\s+/g, "") ?? null;

  const pick = (outcome: CallOutcome, requires: "callback_at" | "meeting_at" | null) => {
    // "won" is the one outcome the domain does not force extra input for, but
    // the deal value is what CAC and ROAS divide by, so it is asked here
    // rather than being chased up later.
    const step = requires ?? (outcome === "won" ? "deal_value" : null);
    setPending(step ? { outcome, requires: step } : null);
  };

  return (
    <ActionForm action={logCallAction} className="space-y-4">
      <input type="hidden" name="campaign_contact_id" value={prospect.id} />
      <input type="hidden" name="campaign_scope" value={campaignScope} />
      {mode ? <input type="hidden" name="mode" value={mode} /> : null}

      {/* ---------------------------------------------- firma a proč ji řešíme */}
      <div className="card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-semibold tracking-tight text-zinc-900">
              {companyName}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {briefing?.priorityLabel ? (
                <Chip tone={briefing.priority === "high" ? "amber" : "zinc"}>
                  {briefing.priorityLabel} priorita
                </Chip>
              ) : null}
              {briefing?.statusLabel ? <Chip>{briefing.statusLabel}</Chip> : null}
              <Chip>
                Pokus {prospect.call_attempts + 1} z {maxAttempts}
              </Chip>
              {briefing?.campaignName ? (
                <span className="text-xs text-zinc-500">{briefing.campaignName}</span>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {briefing?.companyHref ? (
              <a href={briefing.companyHref} className="btn-secondary">
                Detail firmy
              </a>
            ) : null}
          </div>
        </div>

        {briefing?.reason ? (
          <div className="mt-5 rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3">
            <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Proč ji řešíme
            </h3>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-900">
              {briefing.reason}
            </p>
          </div>
        ) : null}

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          {/* --------------------------------------------------- hlavní kontakt */}
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Hlavní kontakt
            </h3>
            <p className="mt-1 text-base font-medium text-zinc-900">{name}</p>
            {prospect.position ? (
              <p className="text-sm text-zinc-600">{prospect.position}</p>
            ) : null}
            <p className="mt-1 text-sm tabular-nums text-zinc-800">{prospect.phone ?? "bez telefonu"}</p>
            <p className="text-sm break-all text-zinc-600">{prospect.email}</p>
          </div>

          {/* ---------------------------------------- co se dělo a co bude dál */}
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Poslední aktivita
            </h3>
            {briefing?.recent.length ? (
              <ul className="mt-1 space-y-1">
                {briefing.recent.map((item) => (
                  <li key={item.id} className="text-sm text-zinc-700">
                    <span className="tabular-nums text-zinc-500">{item.when}</span> — {item.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-zinc-500">Zatím nic — tohle je první kontakt.</p>
            )}

            <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-zinc-500">
              Další krok
            </h3>
            <p
              className={`mt-1 text-sm font-medium ${
                briefing?.nextStepOverdue ? "text-red-600" : "text-zinc-900"
              }`}
            >
              {briefing?.nextStep ?? "Zavolat teď"}
            </p>
          </div>
        </div>

        {prospect.call_note ? (
          <p className="mt-5 rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-700">
            <span className="font-medium">Poslední poznámka:</span> {prospect.call_note}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-2">
          {tel ? (
            <a href={`tel:${tel}`} className="btn-go text-lg">
              Zavolat {prospect.phone}
            </a>
          ) : (
            <span className="badge bg-amber-50 text-amber-700 ring-amber-200">
              Bez telefonu — zavolat nelze
            </span>
          )}
          <a href={`mailto:${prospect.email}`} className="btn-secondary">
            E-mail
          </a>
        </div>
      </div>

      {/* --------------------------------------------------- jak hovor dopadl */}
      <div className="card p-6">
        <h3 className="mb-1 text-sm font-semibold text-zinc-900">Jak hovor dopadl?</h3>
        <p className="mb-3 text-xs text-zinc-500">
          Výsledek se uloží, naplánuje další krok a rovnou načte další firmu.
        </p>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PRIMARY_CALL_OUTCOMES.map((outcome) => (
            <OutcomeButton
              key={outcome.value}
              outcome={outcome}
              tone="primary"
              active={pending?.outcome === outcome.value}
              onPick={pick}
            />
          ))}
          {!showAllOutcomes ? (
            <MoreOutcomesButton onClick={() => setShowAllOutcomes(true)} />
          ) : null}
        </div>

        {showAllOutcomes ? (
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {SECONDARY_CALL_OUTCOMES.map((outcome) => (
              <OutcomeButton
                key={outcome.value}
                outcome={outcome}
                tone="secondary"
                active={pending?.outcome === outcome.value}
                onPick={pick}
              />
            ))}
          </div>
        ) : null}

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
            <div className="mt-3"><SaveButton label="Uložit termín" outcome="callback" /></div>
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
            <span className="label">Kdo volá</span>
            <p className="text-sm font-medium text-zinc-900">{callerName}</p>
            <p className="hint">Platí pro celou směnu · ve frontě {remaining}</p>
          </div>
        </div>
      </div>
    </ActionForm>
  );
}
