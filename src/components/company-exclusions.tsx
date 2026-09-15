"use client";

import { useState } from "react";
import { excludeCompanyAction, removeCompanyExclusionAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import { DateTime } from "./ui";
import { plural } from "@/lib/plan";

/**
 * Klientská vyloučení na detailu firmy.
 *
 * Tohle je užší pojem než stav firmy „vyloučená": ten platí globálně,
 * tohle jen pro jednoho klienta. „Acme je už klientem ASN Plus" nesmí
 * Acme schovat vlastnímu outboundu VEXY, takže se to nesmí zapisovat
 * do `companies.status`.
 *
 * Formulář se rozbaluje: většinu času tu nikdo nic nevylučuje a trvale
 * rozložený formulář by jen zabíral místo v panelu, kde jsou důležitější
 * věci.
 */

export interface ClientOption {
  id: string;
  name: string;
}

export interface CompanyExclusionRow {
  id: string;
  client_id: string;
  client_name: string;
  reason: string | null;
  created_at: Date;
  created_by_name: string | null;
}

export function CompanyExclusions({
  companyId,
  companyName,
  clients,
  exclusions,
}: {
  companyId: string;
  companyName: string;
  clients: ClientOption[];
  exclusions: CompanyExclusionRow[];
}) {
  const [open, setOpen] = useState(false);
  const excludedIds = new Set(exclusions.map((e) => e.client_id));
  const available = clients.filter((c) => !excludedIds.has(c.id));

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">Nekontaktovat pro klienta</h2>
        {available.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="btn-secondary !px-2.5 !py-1 text-xs"
          >
            {open ? "Zavřít" : "Vyloučit pro klienta"}
          </button>
        ) : null}
      </div>

      {exclusions.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-500">
          Firma je k oslovení pro všechny klienty.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {exclusions.map((exclusion) => (
            <li
              key={exclusion.id}
              className="rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-amber-900">{exclusion.client_name}</span>
                <ActionForm action={removeCompanyExclusionAction} hideMessages>
                  <input type="hidden" name="exclusion_id" value={exclusion.id} />
                  <input type="hidden" name="company_id" value={companyId} />
                  <SubmitButton
                    className="btn-secondary !px-2 !py-0.5 text-xs"
                    confirm={
                      `Zrušit vyloučení firmy ${companyName} pro klienta ${exclusion.client_name}? ` +
                      "Firma půjde znovu oslovovat. Dřívější sekvence se ale samy neobnoví."
                    }
                  >
                    Zrušit
                  </SubmitButton>
                </ActionForm>
              </div>
              <p className="text-xs text-amber-900">{exclusion.reason ?? "Bez uvedení důvodu."}</p>
              <p className="mt-0.5 text-xs text-amber-800/70">
                <DateTime value={exclusion.created_at} />
                {exclusion.created_by_name ? ` · ${exclusion.created_by_name}` : " · z importu"}
              </p>
            </li>
          ))}
        </ul>
      )}

      {open && available.length > 0 ? (
        <ActionForm action={excludeCompanyAction} className="mt-4 border-t border-zinc-100 pt-4">
          <input type="hidden" name="company_id" value={companyId} />
          <label className="label" htmlFor="exclusion_client">Klient</label>
          <select id="exclusion_client" name="client_id" required className="input text-sm">
            {available.map((client) => (
              <option key={client.id} value={client.id}>{client.name}</option>
            ))}
          </select>

          <label className="label mt-3" htmlFor="exclusion_reason">Důvod</label>
          <input
            id="exclusion_reason"
            name="reason"
            className="input text-sm"
            placeholder="Např. už je klientem"
          />
          <p className="hint">
            Zastaví e-maily i volání jen pro tohoto klienta. Ostatní klienti firmu oslovují dál.
            Naplánované kroky se zruší — zrušení vyloučení je neobnoví.
          </p>
          <SubmitButton
            className="btn-primary mt-3"
            pendingLabel="Ukládám…"
            confirm={`Vyloučit ${companyName} pro vybraného klienta?`}
          >
            Vyloučit
          </SubmitButton>
        </ActionForm>
      ) : null}

      {available.length === 0 && clients.length > 0 ? (
        <p className="mt-3 text-xs text-zinc-500">
          {/* Konkrétní počet, ne "pro všechny". Klientů může časem přibýt
              a "pro všechny" by pak tiše znamenalo něco jiného - a hlavně
              to zní jako globální blokace, což tohle není. */}
          Firma je vyloučená pro {plural(exclusions.length, "klienta", "klienty", "klientů")}.
        </p>
      ) : null}
      {clients.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-500">
          Zatím nejsou žádní klienti — založte je v Nastavení → Klienti.
        </p>
      ) : null}
    </section>
  );
}
