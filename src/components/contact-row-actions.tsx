"use client";

import { removeFromCampaignAction, skipStepAction, suppressEmailAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

export function ContactRowActions({
  campaignContactId,
  email,
  canResume,
}: {
  campaignContactId: string;
  email: string;
  canResume: boolean;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {canResume ? (
        <ActionForm action={skipStepAction} hideMessages>
          <input type="hidden" name="campaign_contact_id" value={campaignContactId} />
          <SubmitButton
            className="btn-secondary !px-2 !py-1 text-xs"
            confirm="Skip the failed step and continue with the next follow-up?"
          >
            Skip step
          </SubmitButton>
        </ActionForm>
      ) : null}

      <ActionForm action={suppressEmailAction} hideMessages>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="reason" value="manual" />
        <SubmitButton
          className="btn-danger !px-2 !py-1 text-xs"
          confirm={`Add ${email} to the do-not-contact list? They will be excluded from every campaign, now and in future.`}
        >
          Do not contact
        </SubmitButton>
      </ActionForm>

      <ActionForm action={removeFromCampaignAction} hideMessages>
        <input type="hidden" name="campaign_contact_id" value={campaignContactId} />
        <SubmitButton
          className="btn-secondary !px-2 !py-1 text-xs"
          confirm="Remove this contact from the campaign?"
        >
          Remove
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
