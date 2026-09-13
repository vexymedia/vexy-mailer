"use client";

import { useState } from "react";
import {
  callLifecycleLabel,
  formatDuration,
  type CallAnalysis,
} from "@/lib/telephony/call-state";
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
  analysis_status: string;
  analysis: CallAnalysis | null;
  suggested_outcome: string | null;
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
                <div className="mt-3 space-y-3 rounded-md bg-zinc-50 p-3">
                  {call.analysis?.summary ? (
                    <div>
                      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                        Shrnutí{" "}
                        <span className="font-normal normal-case text-zinc-400">· navrhla AI</span>
                      </h3>
                      <p className="mt-1 text-sm leading-relaxed text-zinc-800">
                        {call.analysis.summary}
                      </p>
                    </div>
                  ) : null}
                  {call.analysis?.objections.length ? (
                    <Bullets title="Námitky" items={call.analysis.objections} />
                  ) : null}
                  {call.analysis?.buyingSignals.length ? (
                    <Bullets title="Nákupní signály" items={call.analysis.buyingSignals} />
                  ) : null}
                  {call.analysis?.pains.length ? (
                    <Bullets title="Bolesti" items={call.analysis.pains} />
                  ) : null}
                  {call.transcript ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-zinc-500">
                        Celý přepis
                      </summary>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">
                        {call.transcript}
                      </p>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
      <ul className="mt-1 list-disc pl-4 text-sm text-zinc-700">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
