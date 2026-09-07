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
      <h2 className="mb-1 text-sm font-semibold text-zinc-900">Test mode</h2>
      <p className="mb-5 text-sm text-zinc-600">
        A global switch, applied to every campaign. It is on by default on a fresh install.
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
          <span className="block text-sm font-medium text-zinc-900">Test mode enabled</span>
          <span className="block text-xs text-zinc-500">
            No email can reach a real prospect while this is on.
          </span>
        </span>
      </label>

      <fieldset className="mt-5" disabled={!enabled}>
        <legend className="label">Behaviour while test mode is on</legend>
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
              <span className="block text-sm font-medium text-zinc-900">Redirect to a test address</span>
              <span className="block text-xs text-zinc-500">
                Really sends over SMTP, but every message goes to your address instead, with the
                intended recipient in the subject. The best rehearsal — it exercises the real mail path.
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
              <span className="block text-sm font-medium text-zinc-900">Simulate only</span>
              <span className="block text-xs text-zinc-500">
                No SMTP connection at all. Sends are recorded in the activity log and the sequence
                advances exactly as it would live, including pacing and the daily limit.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-4">
          <label className="label" htmlFor="test_email">Test email address</label>
          <input
            id="test_email"
            name="test_email"
            type="email"
            defaultValue={testEmail}
            className="input max-w-sm"
            placeholder="you@yourdomain.com"
            required={enabled && behavior === "redirect"}
          />
          <p className="hint">Required for redirect mode. Sending is refused outright if it is missing.</p>
        </div>
      </fieldset>

      {!enabled ? (
        <div className="mt-5 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Turning test mode off means the next worker tick will send real emails to real people in
          every active campaign. Make sure that is what you want.
        </div>
      ) : null}

      <div className="mt-6 border-t border-zinc-200 pt-5">
        <SubmitButton
          pendingLabel="Saving…"
          confirm={!enabled ? "Disable test mode and send real emails to real contacts?" : undefined}
        >
          Save settings
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
