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
        confirm={`Přidat ${email} na seznam Nekontaktovat? Bude odebrán ze všech kampaní a už do žádné nepůjde přidat.`}
      >
        Nekontaktovat
      </SubmitButton>
    </ActionForm>
  );
}
