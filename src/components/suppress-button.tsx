"use client";

import { suppressEmailAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";

export function SuppressButton({ email }: { email: string }) {
  return (
    <ActionForm action={suppressEmailAction} hideMessages>
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="reason" value="manual" />
      <SubmitButton
        className="btn-danger !px-2 !py-1 text-xs"
        confirm={`Add ${email} to the do-not-contact list? They will be removed from every campaign and can never be added to another one.`}
      >
        Do not contact
      </SubmitButton>
    </ActionForm>
  );
}
