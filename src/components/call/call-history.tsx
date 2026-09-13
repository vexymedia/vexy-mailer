"use client";

import { useState } from "react";
import {
  SPEAKER_LABELS,
  callLifecycleLabel,
  formatDuration,
  parseSegments,
  type CallAnalysis,
  type TranscriptSegment,
} from "@/lib/telephony/call-state";
import { callOutcomeLabel } from "@/lib/calling";
import { formatWhen } from "@/lib/datetime";

/**
 * Telefonáty u firmy.
 *
 * Timeline má zůstat scannable, takže tady je jen řádek na hovor: kdy,
 * jak dopadl, jak dlouho trval a v jakém stavu je zpracování. Přepis a
 * rozbor se rozbalí, až když je někdo chce - do hlavního výpisu nepatří.
 */

export interface CallHistoryRow {
  id: string;
  status: string;
  started_at: Date | string;
  duration_seconds: number | null;
  recording_status: string;
  transcript_status: string;
  transcript: string | null;
  /** Repliky s rolemi. Null u starých hovorů a u mono nahrávek. */
  transcript_segments: TranscriptSegment[] | null;
  analysis_status: string;
  analysis: CallAnalysis | null;
  suggested_outcome: string | null;
  /** Aktivita, do které se zapsal výsledek. Null = nikdo ho nezapsal. */
  call_activity_id: string | null;
  outcome: string | null;
}

function ProcessingBadge({ call }: { call: CallHistoryRow }) {
  if (call.recording_status === "disabled") {
    return <span className="badge bg-zinc-50 text-zinc-500 ring-zinc-200">bez nahrávky</span>;
  }
  if (call.recording_status === "failed") {
    return <span className="badge bg-amber-50 text-amber-700 ring-amber-200">nahrávka chybí</span>;
  }
  if (call.recording_status === "pending") {
    return <span className="badge bg-zinc-50 text-zinc-600 ring-zinc-200">nahrávka se zpracovává…</span>;
  }
  if (call.transcript_status === "failed" || call.analysis_status === "failed") {
    return <span className="badge bg-amber-50 text-amber-700 ring-amber-200">zpracování selhalo</span>;
  }
  if (call.analysis_status === "done") {
    return <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">zpracováno</span>;
  }
  return <span className="badge bg-zinc-50 text-zinc-600 ring-zinc-200">zpracovává se…</span>;
}

/**
 * Výsledek hovoru, nebo poctivé přiznání, že žádný není.
 *
 * Hovor bez zapsaného výsledku je z pohledu produktu nedodělek: nikde se
 * neprojeví, nikam firmu neposune. Tvářit se, že je řádek v pořádku, by
 * znamenalo ho ztratit.
 */
function OutcomeBadge({ call }: { call: CallHistoryRow }) {
  if (call.outcome) {
    return (
      <span className="badge bg-zinc-100 text-zinc-700 ring-zinc-200">
        {callOutcomeLabel(call.outcome)}
      </span>
    );
  }
  // Stejná podmínka jako u dopsání výsledku ve frontě (`getUnloggedCall`):
  // běžící hovor výsledek mít nemá a u pokusu, který se vůbec nespojil,
  // není co zapisovat. Kdyby se ta dvě místa rozešla, svítila by tu výzva
  // k něčemu, co aplikace jinde nenabízí.
  if (!["completed", "no_answer", "busy"].includes(call.status)) return null;
  return (
    <span className="badge bg-amber-50 text-amber-700 ring-amber-200">bez zapsaného výsledku</span>
  );
}

export function CallHistory({ calls }: { calls: CallHistoryRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (calls.length === 0) return null;

  return (
    <section>
      <h2 className="section-title mb-3">Telefonáty</h2>
      <ul className="card divide-y divide-zinc-100">
        {calls.map((call) => {
          const expanded = open === call.id;
          const hasDetail = Boolean(call.transcript || call.analysis?.summary);
          return (
            <li key={call.id} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span className="text-sm tabular-nums text-zinc-500">
                  {formatWhen(call.started_at)}
                </span>
                <span className="text-sm font-medium text-zinc-900">
                  {callLifecycleLabel(call.status)}
                </span>
                {call.duration_seconds !== null ? (
                  <span className="text-sm tabular-nums text-zinc-600">
                    {formatDuration(call.duration_seconds)}
                  </span>
                ) : null}
                <OutcomeBadge call={call} />
                <ProcessingBadge call={call} />
                {hasDetail ? (
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : call.id)}
                    className="ml-auto text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-900"
                  >
                    {expanded ? "Skrýt detail" : "Detail hovoru"}
                  </button>
                ) : null}
              </div>

              {expanded ? (
                <div className="mt-3 space-y-4 rounded-md bg-zinc-50 p-4">
                  <CallAnalysisView analysis={call.analysis} />
                  <Transcript
                    segments={parseSegments(call.transcript_segments)}
                    flat={call.transcript}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Co z hovoru vyplynulo, v pořadí, v jakém to obchodník potřebuje.
 *
 * Prázdná sekce se nevynechává, ale říká "nezaznělo". Chybějící informace
 * je taky informace - a zamlčet ji by svádělo k tomu myslet si, že něco
 * zaznělo a jen se to ztratilo.
 */
function CallAnalysisView({ analysis }: { analysis: CallAnalysis | null }) {
  if (!analysis) return null;

  const sections: { title: string; items: string[]; text?: string | null }[] = [
    { title: "Shrnutí", items: [], text: analysis.summary },
    { title: "Co prospekt řeší", items: analysis.pains.concat(analysis.needs) },
    { title: "Námitky", items: analysis.objections },
    { title: "Signály zájmu", items: analysis.buyingSignals },
    {
      title: "Dohodnutý další krok",
      items: [],
      text: analysis.nextStep ?? analysis.timing,
    },
    {
      title: "Doporučení pro další kontakt",
      items: [],
      text: analysis.recommendedFollowUp,
    },
  ];

  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
        Z hovoru <span className="font-normal normal-case text-zinc-400">· vyhodnotila AI</span>
      </h3>
      <dl className="mt-2 space-y-2.5">
        {sections.map((section) => (
          <div key={section.title}>
            <dt className="text-xs font-medium text-zinc-500">{section.title}</dt>
            <dd className="mt-0.5 text-sm leading-relaxed text-zinc-800">
              {section.items.length > 0 ? (
                <ul className="list-disc pl-4">
                  {section.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : section.text ? (
                section.text
              ) : (
                <span className="text-zinc-400">nezaznělo</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Přepis jako konverzace.
 *
 * Role nejsou odhad: každá strana hovoru se nahrává do vlastního kanálu
 * a přepisuje zvlášť. Starší hovory mají jen plochý text - ten se ukáže
 * tak, jak je, protože vymýšlet k němu role by byla lež.
 */
function Transcript({
  segments,
  flat,
}: {
  segments: TranscriptSegment[];
  flat: string | null;
}) {
  if (segments.length === 0 && !flat) return null;

  return (
    <details>
      <summary className="cursor-pointer text-xs text-zinc-500">
        {segments.length > 0 ? "Přepis hovoru" : "Přepis hovoru (bez rozlišení řečníků)"}
      </summary>
      {segments.length > 0 ? (
        <dl className="mt-2 space-y-2">
          {segments.map((segment, index) => (
            <div key={`${index}-${segment.start ?? 0}`} className="grid grid-cols-[88px_1fr] gap-3">
              <dt
                className={`text-xs font-medium ${
                  segment.speaker === "agent" ? "text-zinc-500" : "text-emerald-700"
                }`}
              >
                {SPEAKER_LABELS[segment.speaker]}
              </dt>
              <dd className="text-sm leading-relaxed text-zinc-800">{segment.text}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">{flat}</p>
      )}
    </details>
  );
}
