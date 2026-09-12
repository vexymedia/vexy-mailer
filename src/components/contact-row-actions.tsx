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
            confirm="Přeskočit chybný krok a pokračovat dalším follow-upem?"
          >
            Přeskočit krok
          </SubmitButton>
        </ActionForm>
      ) : null}

      <ActionForm action={suppressEmailAction} hideMessages>
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="reason" value="manual" />
        <SubmitButton
          className="btn-danger !px-2 !py-1 text-xs"
          confirm={`Přidat ${email} na seznam Nekontaktovat? Bude vyřazen ze všech kampaní, teď i v budoucnu.`}
        >
          Nekontaktovat
        </SubmitButton>
      </ActionForm>

      <ActionForm action={removeFromCampaignAction} hideMessages>
        <input type="hidden" name="campaign_contact_id" value={campaignContactId} />
        <SubmitButton
          className="btn-secondary !px-2 !py-1 text-xs"
          confirm="Odebrat tento kontakt z kampaně?"
        >
          Odebrat
        </SubmitButton>
      </ActionForm>
    </div>
  );
}
