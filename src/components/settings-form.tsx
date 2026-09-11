"use client";

import { useState } from "react";
import { saveSettingsAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import type { TestBehavior } from "@/lib/types";

/**
 * The single most consequential control in the app, so the form states the
 * consequence of the current selection in plain words rather than leaving the
 * operator to infer it from a checkbox.
 */
export function SettingsForm({
  testMode,
  testEmail,
  testBehavior,
}: {
  testMode: boolean;
  testEmail: string;
  testBehavior: TestBehavior;
}) {
  const [enabled, setEnabled] = useState(testMode);
  const [behavior, setBehavior] = useState<TestBehavior>(testBehavior);

  return (
    <ActionForm action={saveSettingsAction} className="card p-6">
      <h2 className="mb-1 text-sm font-semibold text-zinc-900">Testovací režim</h2>
      <p className="mb-5 text-sm text-zinc-600">
        Globální přepínač platný pro všechny kampaně. V čerstvé instalaci je zapnutý.
      </p>

      <label className="flex items-start gap-3 rounded-md border border-zinc-200 p-4">
        <input
          type="checkbox"
          name="test_mode"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="mt-0.5 size-4 rounded border-zinc-300"
        />
        <span>
          <span className="block text-sm font-medium text-zinc-900">Testovací režim zapnutý</span>
          <span className="block text-xs text-zinc-500">
            Dokud je zapnutý, nemůže se k reálnému prospektovi dostat žádný e-mail.
          </span>
        </span>
      </label>

      <fieldset className="mt-5" disabled={!enabled}>
        <legend className="label">Chování v testovacím režimu</legend>
        <div className="space-y-2">
          <label className="flex items-start gap-3 rounded-md border border-zinc-200 p-4 has-checked:border-zinc-900">
            <input
              type="radio"
              name="test_behavior"
              value="redirect"
              checked={behavior === "redirect"}
              onChange={() => setBehavior("redirect")}
              className="mt-0.5 size-4 border-zinc-300"
            />
            <span>
              <span className="block text-sm font-medium text-zinc-900">Přesměrovat na testovací adresu</span>
              <span className="block text-xs text-zinc-500">
                Opravdu odesílá přes SMTP, ale každá zpráva jde na vaši adresu a zamýšlený příjemce
                je v předmětu. Nejlepší zkouška — projde se skutečná cesta e-mailu.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-md border border-zinc-200 p-4 has-checked:border-zinc-900">
            <input
              type="radio"
              name="test_behavior"
              value="simulate"
              checked={behavior === "simulate"}
              onChange={() => setBehavior("simulate")}
              className="mt-0.5 size-4 border-zinc-300"
            />
            <span>
              <span className="block text-sm font-medium text-zinc-900">Pouze simulovat</span>
              <span className="block text-xs text-zinc-500">
                Žádné SMTP připojení. Odeslání se zapíše do aktivity a sekvence postupuje přesně
                jako naostro, včetně rozložení v čase a denního limitu.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-4">
          <label className="label" htmlFor="test_email">Testovací e-mailová adresa</label>
          <input
            id="test_email"
            name="test_email"
            type="email"
            defaultValue={testEmail}
            className="input max-w-sm"
            placeholder="you@yourdomain.com"
            required={enabled && behavior === "redirect"}
          />
          <p className="hint">Povinná pro přesměrování. Bez ní se odeslání rovnou odmítne.</p>
        </div>
      </fieldset>

      {!enabled ? (
        <div className="mt-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Vypnutím testovacího režimu pošle nejbližší běh workeru skutečné e-maily skutečným lidem
          ve všech běžících kampaních. Ujistěte se, že to opravdu chcete.
        </div>
      ) : null}

      <div className="mt-6 border-t border-zinc-200 pt-5">
        <SubmitButton
          pendingLabel="Ukládám…"
          confirm={!enabled ? "Vypnout testovací režim a posílat skutečné e-maily skutečným kontaktům?" : undefined}
        >
          Uložit nastavení
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
