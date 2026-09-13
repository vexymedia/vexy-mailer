"use client";

import { useRouter } from "next/navigation";
import { PostCallPanel } from "./post-call-panel";

/**
 * Dopsání výsledku k hovoru, který se nestihl zapsat.
 *
 * Stává se to jedním způsobem: caller zavěsí a zavře notebook. Hovor
 * proběhl, ale kontakt o něm neví, takže by se za chvíli objevil jako
 * běžný lead a někdo by mu zavolal podruhé. Fronta ho proto drží stranou
 * a tady se výsledek dopíše - stejným panelem jako po normálním hovoru.
 */
export function CallRecovery({
  callId,
  campaignContactId,
  contactId,
  contactName,
  companyName,
  qualification,
}: {
  callId: string;
  campaignContactId: string | null;
  contactId: string;
  contactName: string;
  companyName: string | null;
  qualification: string | null;
}) {
  const router = useRouter();

  return (
    <div className="card mb-6 border-amber-300 bg-amber-50/60 p-5">
      <h2 className="text-sm font-semibold text-amber-900">
        Nedokončený hovor — chybí výsledek
      </h2>
      <p className="mt-1 text-sm text-amber-900">
        Volali jste{companyName ? ` do firmy ${companyName}` : ""}
        {contactName ? ` (${contactName})` : ""}, ale výsledek se neuložil.
        Dokud ho nedoplníte, kontakt se znovu nenabídne.
      </p>
      <div className="mt-4 max-w-md">
        <PostCallPanel
          callId={callId}
          campaignContactId={campaignContactId}
          contactId={contactId}
          qualification={qualification}
          onDone={() => router.refresh()}
        />
      </div>
    </div>
  );
}
