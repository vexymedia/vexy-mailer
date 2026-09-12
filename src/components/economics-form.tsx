"use client";

import { useState } from "react";
import { saveEconomicsAction } from "@/lib/actions";
import { ActionForm, SubmitButton } from "./action-form";
import {
  CALLER_COST_MODEL_LABELS,
  REVENUE_MODEL_LABELS,
  type CallerCostModel,
  type RevenueModel,
} from "@/lib/calling";

export interface EconomicsValues {
  campaign_id: string;
  revenue_model: RevenueModel;
  revenue_amount: number;
  caller_cost_model: CallerCostModel;
  caller_cost_amount: number;
  caller_hours: number;
  additional_costs: number;
}

/**
 * How this campaign makes and spends money. Only the fields the chosen model
 * actually uses are shown, so nobody fills in an hourly rate for a campaign
 * billed per connected call.
 */
export function EconomicsForm({ values }: { values: EconomicsValues }) {
  const [revenueModel, setRevenueModel] = useState<RevenueModel>(values.revenue_model);
  const [costModel, setCostModel] = useState<CallerCostModel>(values.caller_cost_model);

  const revenueUnit: Record<RevenueModel, string> = {
    deal_values: "",
    fixed: "Kč za kampaň",
    per_meeting_booked: "Kč za domluvenou schůzku",
    per_qualified_meeting: "Kč za kvalifikovanou schůzku",
    per_meeting_held: "Kč za uskutečněnou schůzku",
    per_client: "Kč za získaného klienta",
  };
  const costUnit: Record<CallerCostModel, string> = {
    none: "",
    fixed: "Kč za kampaň",
    hourly: "Kč za hodinu",
    per_connected_call: "Kč za dovolaný hovor",
  };

  return (
    <ActionForm action={saveEconomicsAction} className="card p-6">
      <input type="hidden" name="campaign_id" value={values.campaign_id} />

      <section>
        <h2 className="mb-1 text-sm font-semibold text-zinc-900">Příjem</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Jak se kampaň fakturuje. „Součet hodnot uzavřených obchodů“ je pro vlastní akvizici VEXY —
          příjem se sečte z hodnot u získaných klientů.
        </p>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="revenue_model">Model příjmu</label>
            <select
              id="revenue_model"
              name="revenue_model"
              value={revenueModel}
              onChange={(event) => setRevenueModel(event.target.value as RevenueModel)}
              className="input"
            >
              {(Object.keys(REVENUE_MODEL_LABELS) as RevenueModel[]).map((model) => (
                <option key={model} value={model}>{REVENUE_MODEL_LABELS[model]}</option>
              ))}
            </select>
          </div>
          {revenueModel !== "deal_values" ? (
            <div>
              <label className="label" htmlFor="revenue_amount">Sazba</label>
              <input
                id="revenue_amount"
                name="revenue_amount"
                inputMode="decimal"
                defaultValue={values.revenue_amount}
                className="input"
              />
              <p className="hint">{revenueUnit[revenueModel]}</p>
            </div>
          ) : (
            <input type="hidden" name="revenue_amount" value={values.revenue_amount} />
          )}
        </div>
      </section>

      <section className="mt-8 border-t border-zinc-200 pt-6">
        <h2 className="mb-1 text-sm font-semibold text-zinc-900">Náklady</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Náklad na callera plus cokoliv dalšího, co kampaň stojí (data, nástroje, telefonování).
        </p>
        <div className="grid gap-5 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="caller_cost_model">Model nákladu na callera</label>
            <select
              id="caller_cost_model"
              name="caller_cost_model"
              value={costModel}
              onChange={(event) => setCostModel(event.target.value as CallerCostModel)}
              className="input"
            >
              {(Object.keys(CALLER_COST_MODEL_LABELS) as CallerCostModel[]).map((model) => (
                <option key={model} value={model}>{CALLER_COST_MODEL_LABELS[model]}</option>
              ))}
            </select>
          </div>
          {costModel !== "none" ? (
            <div>
              <label className="label" htmlFor="caller_cost_amount">Sazba</label>
              <input
                id="caller_cost_amount"
                name="caller_cost_amount"
                inputMode="decimal"
                defaultValue={values.caller_cost_amount}
                className="input"
              />
              <p className="hint">{costUnit[costModel]}</p>
            </div>
          ) : (
            <input type="hidden" name="caller_cost_amount" value={values.caller_cost_amount} />
          )}
          {costModel === "hourly" ? (
            <div>
              <label className="label" htmlFor="caller_hours">Odpracované hodiny</label>
              <input
                id="caller_hours"
                name="caller_hours"
                inputMode="decimal"
                defaultValue={values.caller_hours}
                className="input"
              />
            </div>
          ) : (
            <input type="hidden" name="caller_hours" value={values.caller_hours} />
          )}
        </div>

        <div className="mt-5 max-w-xs">
          <label className="label" htmlFor="additional_costs">Ostatní náklady kampaně (Kč)</label>
          <input
            id="additional_costs"
            name="additional_costs"
            inputMode="decimal"
            defaultValue={values.additional_costs}
            className="input"
          />
        </div>
      </section>

      <div className="mt-6 border-t border-zinc-200 pt-5">
        <SubmitButton pendingLabel="Ukládám…">Uložit ekonomiku</SubmitButton>
      </div>
    </ActionForm>
  );
}
