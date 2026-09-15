"use client";

import { useEffect, useState } from "react";
import { ActionForm, SubmitButton } from "../action-form";
import { setCallRecordingAction } from "@/lib/actions";

/**
 * Nastavení volání.
 *
 * Schválně málo: co je připojené, co se slyší, a jestli se nahrává.
 * Výběr vstupu a výstupu řeší prohlížeč sám a lépe - duplikovat ho by
 * znamenalo dvě místa, kde se dá nastavit špatný mikrofon.
 */

type MicState = "unknown" | "checking" | "granted" | "denied" | "missing" | "unsupported";

const MIC_LABELS: Record<MicState, string> = {
  unknown: "Nezjištěno",
  checking: "Zjišťuji…",
  granted: "Mikrofon je povolený",
  denied: "Mikrofon je zakázaný",
  missing: "Žádný mikrofon nenalezen",
  unsupported: "Tenhle prohlížeč volání neumí",
};

export function CallingSettings({
  configured,
  missing,
  recordingEnabled,
  callerId,
}: {
  configured: boolean;
  missing: string[];
  recordingEnabled: boolean;
  callerId: string | null;
}) {
  const [mic, setMic] = useState<MicState>("unknown");
  const [devices, setDevices] = useState<{ input: number; output: number } | null>(null);

  // Stav povolení se čte bez vyžádání, aby otevření nastavení nevyvolalo
  // dialog prohlížeče. Ptáme se až tlačítkem.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setMic("unsupported");
      return;
    }
    navigator.permissions
      ?.query({ name: "microphone" as PermissionName })
      .then((status) => {
        if (status.state === "granted") setMic("granted");
        else if (status.state === "denied") setMic("denied");
      })
      .catch(() => {
        // Safari permissions API pro mikrofon nemá - necháme "nezjištěno".
      });
  }, []);

  const check = async () => {
    setMic("checking");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMic("granted");
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices({
        input: list.filter((device) => device.kind === "audioinput").length,
        output: list.filter((device) => device.kind === "audiooutput").length,
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setMic(name === "NotFoundError" ? "missing" : "denied");
    }
  };

  return (
    <div className="card p-6">
      <h2 className="mb-3 text-sm font-semibold text-zinc-900">Volání</h2>

      <dl className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-zinc-600">Připojení k telefonii</dt>
          <dd>
            {configured ? (
              <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">nastaveno</span>
            ) : (
              <span className="badge bg-amber-50 text-amber-700 ring-amber-200">není nastaveno</span>
            )}
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <dt className="text-zinc-600">Mikrofon</dt>
          <dd className="flex items-center gap-2">
            <span
              className={`badge ${
                mic === "granted"
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : mic === "unknown" || mic === "checking"
                    ? "bg-zinc-50 text-zinc-600 ring-zinc-200"
                    : "bg-amber-50 text-amber-700 ring-amber-200"
              }`}
            >
              {MIC_LABELS[mic]}
            </span>
            <button type="button" onClick={check} className="btn-secondary !px-2 !py-1 text-xs">
              Otestovat
            </button>
          </dd>
        </div>
        {devices ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-zinc-600">Zvuková zařízení</dt>
            <dd className="text-zinc-900">
              {devices.input} vstup{devices.input === 1 ? "" : devices.input < 5 ? "y" : "ů"} ·{" "}
              {devices.output} výstup{devices.output === 1 ? "" : devices.output < 5 ? "y" : "ů"}
            </dd>
          </div>
        ) : null}
        {callerId ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-zinc-600">Číslo, které uvidí volaný</dt>
            <dd className="tabular-nums text-zinc-900">{callerId}</dd>
          </div>
        ) : null}
      </dl>

      {!configured ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p>Volání z prohlížeče zatím není zapnuté. Chybí:</p>
          <ul className="mt-1 list-disc pl-5 font-mono text-xs">
            {missing.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs">
            Postup je v <code className="font-mono">docs/calling.md</code>. Do té doby tlačítko
            Zavolat po kliknutí jen zopakuje tenhle seznam — volat nejde.
          </p>
        </div>
      ) : null}

      <ActionForm action={setCallRecordingAction} className="mt-5 border-t border-zinc-200 pt-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="call_recording_enabled"
            defaultChecked={recordingEnabled}
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-medium text-zinc-900">Nahrávat hovory</span>
            <span className="hint block">
              Z nahrávky vzniká přepis a shrnutí hovoru. Když je vypnuté, volání funguje dál — jen
              bez nahrávky, přepisu a analýzy.
            </span>
          </span>
        </label>
        <div className="mt-4">
          <SubmitButton pendingLabel="Ukládám…">Uložit</SubmitButton>
        </div>
      </ActionForm>
    </div>
  );
}
