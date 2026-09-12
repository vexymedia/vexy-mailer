"use client";

import { runWorkerNowAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

/**
 * Runs one worker tick on demand. Useful for verifying a fresh deployment
 * without waiting for the cron, and harmless to press: the tick is idempotent.
 */
export function RunWorkerButton() {
  return (
    <ActionForm action={runWorkerNowAction} hideMessages>
      {(state) => (
        <div className="flex items-center gap-3">
          {state.success ? (
            <span className="max-w-md text-xs text-zinc-500">{state.success}</span>
          ) : null}
          {state.error ? <span className="max-w-md text-xs text-red-600">{state.error}</span> : null}
          <SubmitButton className="btn-secondary" pendingLabel="Spouštím…">
            Spustit worker
          </SubmitButton>
        </div>
      )}
    </ActionForm>
  );
}
