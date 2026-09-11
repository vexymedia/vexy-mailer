"use client";

import { updateMeetingAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

/**
 * The two judgements a booked meeting still needs: did it meet the campaign's
 * qualification criteria, and did it actually happen. Both are one click, and
 * neither touches the attempt counter - this is not a dialling attempt.
 */
export function MeetingActions({
  campaignContactId,
  qualified,
  held,
}: {
  campaignContactId: string;
  qualified: boolean | null;
  held: boolean;
}) {
  return (
    <div className="space-y-3">
      <ActionForm action={updateMeetingAction} hideMessages className="flex flex-wrap gap-2">
        <input type="hidden" name="campaign_contact_id" value={campaignContactId} />
        <input type="hidden" name="qualified" value={qualified === true ? "no" : "yes"} />
        <SubmitButton className={qualified === true ? "btn-secondary" : "btn-go"}>
          {qualified === true ? "Zrušit kvalifikaci" : "Označit jako kvalifikovanou"}
        </SubmitButton>
      </ActionForm>

      <ActionForm action={updateMeetingAction} hideMessages className="flex flex-wrap gap-2">
        <input type="hidden" name="campaign_contact_id" value={campaignContactId} />
        <input type="hidden" name="held" value={held ? "no" : "yes"} />
        <SubmitButton className="btn-secondary">
          {held ? "Zrušit „uskutečněná“" : "Označit jako uskutečněnou"}
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
