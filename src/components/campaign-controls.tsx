"use client";

import { pauseCampaignAction, startCampaignAction, deleteCampaignAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import type { CampaignStatus } from "@/lib/types";

/**
 * Start / Pause / Resume. A draft never starts implicitly, and starting runs
 * the readiness check first, so an unstartable campaign explains why.
 */
export function CampaignControls({ id, status }: { id: string; status: CampaignStatus }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {status === "active" ? (
          <ActionForm action={pauseCampaignAction} hideMessages>
            <input type="hidden" name="id" value={id} />
            <SubmitButton className="btn-secondary" pendingLabel="Pausing…">
              Pause
            </SubmitButton>
          </ActionForm>
        ) : (
          <ActionForm action={startCampaignAction}>
            {(state) => (
              <div>
                <input type="hidden" name="id" value={id} />
                <SubmitButton
                  className="btn-go"
                  pendingLabel="Starting…"
                  confirm={
                    status === "draft"
                      ? "Start this campaign? Check the test-mode banner at the top of the page first."
                      : undefined
                  }
                >
                  {status === "paused" ? "Resume" : "Start campaign"}
                </SubmitButton>
                {state.error ? <span className="ml-3 text-sm text-red-600">{state.error}</span> : null}
              </div>
            )}
          </ActionForm>
        )}

        {status !== "active" ? (
          <ActionForm action={deleteCampaignAction} hideMessages>
            <input type="hidden" name="id" value={id} />
            <SubmitButton className="btn-danger" confirm="Delete this campaign and all of its send history?">
              Delete
            </SubmitButton>
          </ActionForm>
        ) : null}
      </div>
    </div>
  );
}
