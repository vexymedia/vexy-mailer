"use client";

import { useState } from "react";
import Link from "next/link";
import { CALL_UI_LABELS, CallTimer, useCalling, type CallUiState } from "./call-provider";
import { PostCallPanel } from "./post-call-panel";

/**
 * Lišta hovoru a cockpit.
 *
 * Obojí kreslí layout, ne stránka - proto hovor přežije přechod na jinou
 * obrazovku. Lišta je vždycky vidět, cockpit je přes ni a dá se zavřít,
 * aniž by se hovor položil.
 */

const STATE_TONE: Record<CallUiState, string> = {
  idle: "bg-zinc-900",
  permission: "bg-zinc-900",
  connecting: "bg-zinc-900",
  ringing: "bg-zinc-900",
  active: "bg-emerald-700",
  ending: "bg-zinc-900",
  ended: "bg-zinc-800",
  failed: "bg-red-800",
};

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

function StateDot({ state }: { state: CallUiState }) {
  const live = state === "connecting" || state === "ringing";
  return (
    <span className="relative flex size-2.5 shrink-0">
      {live ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/60" />
      ) : null}
      <span
        className={`relative inline-flex size-2.5 rounded-full ${
          state === "active" ? "bg-emerald-300" : state === "failed" ? "bg-red-300" : "bg-zinc-400"
        }`}
      />
    </span>
  );
}

export function CallSurface() {
  const calling = useCalling();
  const { state, call, cockpitOpen } = calling;
  if (state === "idle" || !call) return null;

  return (
    <>
      {/* Lišta je fixní, takže by jinak překryla konec stránky. */}
      <div aria-hidden className="h-16" />
      <CallBar />
      {cockpitOpen ? <CallCockpit /> : null}
    </>
  );
}

function CallBar() {
  const { state, call, muted, hangUp, toggleMute, openCockpit, cockpitOpen } = useCalling();
  if (!call) return null;
  const ongoing = state === "connecting" || state === "ringing" || state === "active" || state === "ending";

  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-30 text-white shadow-lg ${STATE_TONE[state]} ${
        cockpitOpen ? "hidden" : ""
      }`}
    >
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
        <button
          type="button"
          onClick={openCockpit}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <StateDot state={state} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{call.target.contactName}</span>
            <span className="block truncate text-xs text-white/70">
              {call.target.companyName ?? call.target.destination}
            </span>
          </span>
          <span className="ml-auto shrink-0 text-sm font-medium sm:ml-4">
            {state === "active" ? (
              <CallTimer since={call.answeredAt} />
            ) : (
              CALL_UI_LABELS[state]
            )}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          {ongoing ? (
            <>
              <button
                type="button"
                onClick={toggleMute}
                className={`rounded-md px-3 py-1.5 text-sm ring-1 ring-inset ring-white/25 ${
                  muted ? "bg-white text-zinc-900" : "hover:bg-white/10"
                }`}
              >
                {muted ? "Ztlumeno" : "Ztlumit"}
              </button>
              <button
                type="button"
                onClick={hangUp}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium hover:bg-red-500"
              >
                Zavěsit
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={openCockpit}
              className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100"
            >
              Zapsat výsledek
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CallCockpit() {
  const { state, call, error, errorCode, muted, hangUp, toggleMute, sendDigit, closeCockpit, retry, dismiss } =
    useCalling();
  const [keypadOpen, setKeypadOpen] = useState(false);
  if (!call) return null;

  const briefing = call.briefing;
  const ongoing = state === "connecting" || state === "ringing" || state === "active" || state === "ending";
  const finished = state === "ended" || state === "failed";

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-zinc-950/50 backdrop-blur-[1px]">
      <div className="mx-auto min-h-full w-full max-w-5xl p-3 sm:p-6">
        <div className="card overflow-hidden">
          {/* --------------------------------------------------- hlavička */}
          <div className={`flex flex-wrap items-center gap-3 px-5 py-3 text-white ${STATE_TONE[state]}`}>
            <StateDot state={state} />
            <span className="text-sm font-medium">{CALL_UI_LABELS[state]}</span>
            {state === "active" ? (
              <span className="text-sm font-medium">
                <CallTimer since={call.answeredAt} />
              </span>
            ) : null}
            {state === "ended" && call.durationSeconds !== null ? (
              <span className="text-sm text-white/80">
                {Math.floor(call.durationSeconds / 60)}:
                {String(call.durationSeconds % 60).padStart(2, "0")}
              </span>
            ) : null}
            <button
              type="button"
              onClick={closeCockpit}
              className="ml-auto rounded-md px-2 py-1 text-sm text-white/80 ring-1 ring-inset ring-white/25 hover:bg-white/10"
            >
              Skrýt
            </button>
          </div>

          {error ? (
            <div className="flex flex-wrap items-center gap-3 border-b border-red-200 bg-red-50 px-5 py-3">
              <p className="min-w-0 flex-1 text-sm text-red-800">
                {error}
                {errorCode ? (
                  <span className="ml-2 text-xs text-red-500">(kód {errorCode})</span>
                ) : null}
              </p>
              {state === "failed" ? (
                <button type="button" onClick={retry} className="btn-secondary shrink-0">
                  Zkusit znovu
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            {/* ---------------------------------------------- kdo a proč */}
            <div className="border-b border-zinc-200 p-5 lg:border-b-0 lg:border-r">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-xl font-semibold tracking-tight text-zinc-900">
                    {call.target.contactName}
                  </h2>
                  {briefing?.position ? (
                    <p className="text-sm text-zinc-600">{briefing.position}</p>
                  ) : null}
                  <p className="mt-0.5 text-sm text-zinc-900">
                    {call.target.companyName ?? "—"}
                  </p>
                  <p className="mt-1 text-sm tabular-nums text-zinc-700">{call.target.destination}</p>
                  {briefing?.email ? (
                    <p className="text-xs break-all text-zinc-500">{briefing.email}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  {briefing?.priorityLabel ? (
                    <span className="badge bg-zinc-100 text-zinc-700 ring-zinc-200">
                      {briefing.priorityLabel} priorita
                    </span>
                  ) : null}
                  {briefing?.statusLabel ? (
                    <span className="badge bg-zinc-100 text-zinc-700 ring-zinc-200">
                      {briefing.statusLabel}
                    </span>
                  ) : null}
                  <span className="badge bg-zinc-100 text-zinc-700 ring-zinc-200">
                    Pokus {briefing?.attempt ?? 1}
                    {briefing?.maxAttempts ? ` z ${briefing.maxAttempts}` : ""}
                  </span>
                </div>
              </div>

              {briefing?.reason ? (
                <div className="mt-4 rounded-md border border-zinc-200 bg-zinc-50 px-4 py-3">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Proč ji řešíme
                  </h3>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-900">
                    {briefing.reason}
                  </p>
                </div>
              ) : null}

              {briefing?.recent.length ? (
                <div className="mt-4">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Poslední aktivita
                  </h3>
                  <ul className="mt-1 space-y-1">
                    {briefing.recent.map((item) => (
                      <li key={item.id} className="text-sm text-zinc-700">
                        <span className="tabular-nums text-zinc-500">{item.when}</span> — {item.text}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="mt-5 flex flex-wrap items-center gap-2">
                {ongoing ? (
                  <>
                    <button
                      type="button"
                      onClick={hangUp}
                      className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500"
                    >
                      Zavěsit
                    </button>
                    <button
                      type="button"
                      onClick={toggleMute}
                      className={muted ? "btn-primary" : "btn-secondary"}
                    >
                      {muted ? "Zapnout mikrofon" : "Ztlumit"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setKeypadOpen((open) => !open)}
                      className="btn-secondary"
                    >
                      Klávesnice
                    </button>
                  </>
                ) : null}
                {call.target.companyId ? (
                  <Link href={`/firmy/${call.target.companyId}`} className="btn-secondary">
                    Detail firmy
                  </Link>
                ) : null}
              </div>

              {keypadOpen && ongoing ? (
                <div className="mt-4 grid max-w-56 grid-cols-3 gap-2">
                  {DIGITS.map((digit) => (
                    <button
                      key={digit}
                      type="button"
                      onClick={() => sendDigit(digit)}
                      className="rounded-md border border-zinc-300 bg-white py-2 text-base tabular-nums text-zinc-900 hover:bg-zinc-50"
                    >
                      {digit}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            {/* ------------------------------- co říct, a po hovoru výsledek */}
            <div className="p-5">
              {finished ? (
                <PostCallPanel
                  callId={call.target.callId}
                  campaignContactId={call.target.campaignContactId}
                  qualification={briefing?.qualification ?? null}
                  onDone={dismiss}
                />
              ) : (
                <>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                    Co říct
                  </h3>
                  {briefing?.script.length ? (
                    <div className="mt-2 space-y-3">
                      {briefing.script.map((panel) => (
                        <div key={panel.title} className="rounded-md border border-zinc-200 p-3">
                          <h4 className="text-xs font-medium text-zinc-500">{panel.title}</h4>
                          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800">
                            {panel.text}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-zinc-500">
                      Kampaň nemá vyplněný scénář. Doplnit se dá v nastavení volání.
                    </p>
                  )}
                  {briefing?.qualification ? (
                    <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50/60 p-3">
                      <h4 className="text-xs font-medium text-emerald-800">Kritéria kvalifikace</h4>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-800">
                        {briefing.qualification}
                      </p>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
