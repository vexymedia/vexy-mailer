"use client";

import { updateMeetingAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import { MEETING_OUTCOME_LABELS, type MeetingOutcome } from "@/lib/calling";

/**
 * The two judgements a booked meeting still needs: does it meet the campaign's
 * qualification criteria, and what became of it. Neither is a dialling attempt,
 * so neither touches the attempt counter.
 *
 * "Uskutečněná" and "Nedorazil" are separate answers on purpose - a boolean
 * could not tell a meeting that has not happened yet from one the prospect
 * never turned up to, and only one of those is billable.
 */
export function MeetingActions({
  campaignContactId,
  qualified,
  outcome,
}: {
  campaignContactId: string;
  qualified: boolean | null;
  outcome: MeetingOutcome;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs font-medium text-zinc-500">Kvalifikace</p>
        <ActionForm action={updateMeetingAction} hideMessages className="flex flex-wrap gap-2">
          <input type="hidden" name="campaign_contact_id" value={campaignContactId} />
          <input type="hidden" name="qualified" value={qualified === true ? "no" : "yes"} />
          <SubmitButton className={qualified === true ? "btn-secondary" : "btn-go"}>
            {qualified === true ? "Zrušit kvalifikaci" : "Označit jako kvalifikovanou"}
          </SubmitButton>
        </ActionForm>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-zinc-500">Stav schůzky</p>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(MEETING_OUTCOME_LABELS) as MeetingOutcome[]).map((value) => (
            <ActionForm key={value} action={updateMeetingAction} hideMessages>
              <input type="hidden" name="campaign_contact_id" value={campaignContactId} />
              <input type="hidden" name="meeting_outcome" value={value} />
              <SubmitButton
                className={
                  outcome === value
                    ? "btn bg-zinc-900 text-white !px-3 !py-1.5 text-xs"
                    : "btn-secondary !px-3 !py-1.5 text-xs"
                }
              >
                {MEETING_OUTCOME_LABELS[value]}
              </SubmitButton>
            </ActionForm>
          ))}
        </div>
      </div>
    </div>
  );
}
