"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "./action-form";
import { saveContactAction } from "@/lib/actions";

/**
 * Přidání a úprava kontaktu.
 *
 * Jeden formulář pro obojí - liší se jen tím, jestli má vyplněné id.
 * Telefon se normalizuje na serveru; číslo, které nejde vytočit, se
 * neuloží a člověk to zjistí hned, ne až u hovoru.
 */

export interface ContactFormValues {
  id?: string;
  firstName?: string | null;
  lastName?: string | null;
  position?: string | null;
  email?: string;
  phone?: string | null;
  isPrimary?: boolean;
}

export function ContactForm({
  companyId,
  contact,
  onClose,
}: {
  companyId: string;
  contact?: ContactFormValues;
  onClose: () => void;
}) {
  return (
    <ActionForm action={saveContactAction} className="rounded-md border border-zinc-300 bg-white p-4">
      <input type="hidden" name="company_id" value={companyId} />
      {contact?.id ? <input type="hidden" name="contact_id" value={contact.id} /> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor={`first_${contact?.id ?? "new"}`}>Jméno</label>
          <input
            id={`first_${contact?.id ?? "new"}`}
            name="first_name"
            defaultValue={contact?.firstName ?? ""}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor={`last_${contact?.id ?? "new"}`}>Příjmení</label>
          <input
            id={`last_${contact?.id ?? "new"}`}
            name="last_name"
            defaultValue={contact?.lastName ?? ""}
            className="input"
          />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`position_${contact?.id ?? "new"}`}>Pozice</label>
          <input
            id={`position_${contact?.id ?? "new"}`}
            name="position"
            defaultValue={contact?.position ?? ""}
            className="input"
            placeholder="např. jednatel"
          />
        </div>
        <div>
          <label className="label" htmlFor={`email_${contact?.id ?? "new"}`}>E-mail</label>
          <input
            id={`email_${contact?.id ?? "new"}`}
            name="email"
            type="email"
            required
            defaultValue={contact?.email ?? ""}
            className="input"
          />
        </div>
        <div>
          <label className="label" htmlFor={`phone_${contact?.id ?? "new"}`}>Telefon</label>
          <input
            id={`phone_${contact?.id ?? "new"}`}
            name="phone"
            inputMode="tel"
            defaultValue={contact?.phone ?? ""}
            className="input"
            placeholder="737485738"
          />
          <p className="hint">České číslo stačí devítimístné, doplní se +420.</p>
        </div>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm text-zinc-800">
        <input type="checkbox" name="is_primary" defaultChecked={contact?.isPrimary ?? false} />
        Hlavní kontakt firmy
      </label>

      <div className="mt-4 flex items-center gap-2">
        <SubmitButton pendingLabel="Ukládám…">
          {contact?.id ? "Uložit kontakt" : "Přidat kontakt"}
        </SubmitButton>
        <button type="button" onClick={onClose} className="btn-secondary">
          Zrušit
        </button>
      </div>
    </ActionForm>
  );
}

/** Tlačítko, které formulář rozbalí. Používá se pro přidání i pro úpravu. */
export function ContactFormToggle({
  companyId,
  contact,
  label,
  className = "btn-primary",
}: {
  companyId: string;
  contact?: ContactFormValues;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {label}
      </button>
    );
  }
  return <ContactForm companyId={companyId} contact={contact} onClose={() => setOpen(false)} />;
}
