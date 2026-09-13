"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, SubmitButton } from "../action-form";
import { logCallAction } from "@/lib/actions";
import {
  PRIMARY_CALL_OUTCOMES,
  SECONDARY_CALL_OUTCOMES,
  callOutcomeLabel,
  type CallOutcome,
} from "@/lib/calling";
import type { CallAnalysis } from "@/lib/telephony/call-state";

/**
 * Co se děje hned po zavěšení.
 *
 * Pravidlo: caller nesmí čekat. Výsledek jde zapsat okamžitě, i když AI
 * ještě nedoběhla - shrnutí a návrh se doplní samy a zůstanou u hovoru.
 * Modální okno s dvaceti políčky by celý smysl produktu zabilo.
 */

interface CallState {
  status: string;
  durationSeconds: number | null;
  recordingStatus: string;
  transcriptStatus: string;
  analysisStatus: string;
  analysis: CallAnalysis | null;
  analysisError: string | null;
  suggestedOutcome: string | null;
  loggedOutcome: boolean;
}

const PENDING_STATES = ["pending", "processing"];

export function PostCallPanel({
  callId,
  campaignContactId,
  qualification,
  onDone,
}: {
  callId: string;
  campaignContactId: string | null;
  qualification: string | null;
  onDone: () => void;
}) {
  const router = useRouter();
  const [remote, setRemote] = useState<CallState | null>(null);
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [touched, setTouched] = useState(false);

  // Dotazování běží jen dokud je na co čekat, a zastaví se samo.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`/api/calling/calls/${callId}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as CallState;
        if (cancelled) return;
        setRemote(data);
        // Návrh se předvybere jen dokud si caller nevybral sám.
        setOutcome((current) => {
          if (touched || current) return current;
          return (data.suggestedOutcome as CallOutcome | null) ?? null;
        });
        // Dotazovat se má smysl jen dokud se něco zpracovává. U hovoru,
        // který se nespojil, by se jinak ptalo donekonečna.
        const reachedProvider = data.status === "completed" || data.durationSeconds !== null;
        const waiting =
          (data.recordingStatus === "available" &&
            (PENDING_STATES.includes(data.transcriptStatus) ||
              PENDING_STATES.includes(data.analysisStatus))) ||
          (reachedProvider && PENDING_STATES.includes(data.recordingStatus));
        if (waiting && !cancelled) timer = setTimeout(poll, 5000);
      } catch {
        // Výpadek dotazu nic nerozbíjí - zápis výsledku na něm nezávisí.
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [callId, touched]);

  const analysis = remote?.analysis ?? null;
  // "AI zpracovává" se smí ukázat jen tam, kde se opravdu něco zpracovává.
  // U hovoru, který se vůbec nespojil, žádná nahrávka nevznikne a čekat
  // na ni by byla lež.
  const connected = remote?.status === "completed" || remote?.durationSeconds !== null;
  const processing =
    remote !== null &&
    ((remote.recordingStatus === "available" &&
      (PENDING_STATES.includes(remote.transcriptStatus) ||
        PENDING_STATES.includes(remote.analysisStatus))) ||
      (connected && PENDING_STATES.includes(remote.recordingStatus)));

  const needsCallback = outcome === "callback";
  const needsMeeting = outcome === "meeting_booked";

  if (!campaignContactId) {
    return (
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">Hovor ukončen</h3>
        <p className="mt-2 text-sm text-zinc-600">
          Tenhle kontakt není v žádné kampani, takže k němu nejde zapsat výsledek volání.
          Hovor i jeho nahrávka se ukládají k firmě.
        </p>
        <button type="button" onClick={onDone} className="btn-primary mt-4">
          Zavřít
        </button>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-zinc-900">Jak hovor dopadl?</h3>

      {processing ? (
        <p className="mt-2 flex items-center gap-2 rounded-md bg-zinc-100 px-3 py-2 text-xs text-zinc-600">
          <span className="inline-block size-2 animate-pulse rounded-full bg-zinc-400" />
          AI zpracovává hovor… Výsledek můžete zapsat hned, shrnutí se doplní samo.
        </p>
      ) : null}

      {analysis?.summary ? (
        <div className="mt-3 rounded-md border border-zinc-200 bg-zinc-50 p-3">
          <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Shrnutí <span className="font-normal normal-case text-zinc-400">· navrhla AI</span>
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-zinc-800">{analysis.summary}</p>
          {analysis.objections.length > 0 ? (
            <>
              <h4 className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Námitky</h4>
              <ul className="mt-1 list-disc pl-4 text-sm text-zinc-700">
                {analysis.objections.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          ) : null}
          {analysis.nextStep ? (
            <p className="mt-3 text-sm text-zinc-700">
              <span className="font-medium">Navržený další krok:</span> {analysis.nextStep}
            </p>
          ) : null}
        </div>
      ) : null}

      {remote?.analysisStatus === "failed" ? (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Analýzu se nepodařilo dokončit. Hovor i nahrávka zůstávají uložené.
        </p>
      ) : null}

      {remote?.loggedOutcome ? (
        <div className="mt-4">
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Výsledek je zapsaný.
          </p>
          <button type="button" onClick={onDone} className="btn-go mt-3 w-full">
            Další kontakt
          </button>
        </div>
      ) : (
        <ActionForm
          action={logCallAction}
          className="mt-4 space-y-3"
          onSuccess={() => {
            // Fronta i detail firmy se musí překreslit, jinak by caller
            // pokračoval na firmu, kterou právě uzavřel.
            router.refresh();
          }}
        >
          <input type="hidden" name="campaign_contact_id" value={campaignContactId} />
          <input type="hidden" name="call_id" value={callId} />
          <input type="hidden" name="campaign_scope" value="" />

          <div className="grid grid-cols-2 gap-2">
            {(showAll ? [...PRIMARY_CALL_OUTCOMES, ...SECONDARY_CALL_OUTCOMES] : PRIMARY_CALL_OUTCOMES).map(
              (definition) => {
                const active = outcome === definition.value;
                const suggested = remote?.suggestedOutcome === definition.value;
                return (
                  <button
                    key={definition.value}
                    type="button"
                    onClick={() => {
                      setTouched(true);
                      setOutcome(definition.value);
                    }}
                    className={`btn justify-start border text-left text-sm ${
                      active
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50"
                    }`}
                  >
                    <span className="min-w-0 leading-snug">{definition.label}</span>
                    {suggested && !active ? (
                      <span className="ml-1 shrink-0 text-[10px] uppercase text-zinc-400">AI</span>
                    ) : null}
                  </button>
                );
              },
            )}
            {!showAll ? (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="btn justify-start border border-dashed border-zinc-300 text-left text-sm text-zinc-500 hover:bg-zinc-50"
              >
                Další výsledky…
              </button>
            ) : null}
          </div>

          {needsCallback ? (
            <div>
              <label className="label" htmlFor="post_callback_at">Kdy zavolat znovu</label>
              <input
                id="post_callback_at"
                name="callback_at"
                type="datetime-local"
                defaultValue={defaultWhen(1)}
                required
                className="input"
              />
            </div>
          ) : null}

          {needsMeeting ? (
            <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50/60 p-3">
              <div>
                <label className="label" htmlFor="post_meeting_at">Termín schůzky</label>
                <input
                  id="post_meeting_at"
                  name="meeting_at"
                  type="datetime-local"
                  defaultValue={defaultWhen(3)}
                  required
                  className="input"
                />
              </div>
              {qualification ? (
                <p className="text-xs text-zinc-600">{qualification}</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {[
                  { value: "yes", label: "Kvalifikovaná" },
                  { value: "no", label: "Nekvalifikovaná" },
                  { value: "", label: "Posoudit později" },
                ].map((option) => (
                  <label
                    key={option.label}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs has-checked:border-zinc-900 has-checked:bg-zinc-900 has-checked:text-white"
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
            </div>
          ) : null}

          <div>
            <label className="label" htmlFor="post_note">Poznámka (nepovinné)</label>
            <textarea
              id="post_note"
              name="note"
              rows={2}
              className="input"
              defaultValue={analysis?.summary ?? ""}
              placeholder="Co bylo domluveno…"
            />
          </div>

          {outcome ? (
            <SubmitButton className="btn-go w-full" name="outcome" value={outcome}>
              Potvrdit „{callOutcomeLabel(outcome)}“ a další kontakt
            </SubmitButton>
          ) : (
            <p className="text-xs text-zinc-500">Vyberte výsledek hovoru.</p>
          )}

          <button type="button" onClick={onDone} className="btn-secondary w-full">
            Pokračovat na další kontakt bez zápisu
          </button>
        </ActionForm>
      )}
    </div>
  );
}

/** Za N pracovních dní v deset, stejně jako kadence na serveru. */
function defaultWhen(workingDays: number): string {
  const when = new Date();
  let added = 0;
  while (added < workingDays) {
    when.setDate(when.getDate() + 1);
    if (when.getDay() !== 0 && when.getDay() !== 6) added++;
  }
  when.setHours(10, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}
