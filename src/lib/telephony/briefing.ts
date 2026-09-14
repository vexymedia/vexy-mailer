import { sql } from "../db";
import { callOutcomeLabel } from "../calling";
import { companyPriorityLabel, companyStatusLabel } from "../companies";
import { formatPast, formatWhen } from "../datetime";
import { getContactTimeline } from "../queries/calling";
import { buildOpener, buildWhyNow, getLeadContext } from "../queries/lead-context";
import { toLeadContextView } from "../lead-context-view";
import type { CallBriefing } from "@/components/call/call-provider";

/**
 * Co caller potřebuje mít na očích během hovoru.
 *
 * Skládá se na serveru a do cockpitu jde hotové - časy se formátují jednou,
 * v pražské zóně, a nemůžou se po hydrataci rozejít.
 */
export async function buildCockpitBriefing(input: {
  contactId: string;
  companyId: string | null;
  campaignContactId: string | null;
  /** Kdo volá. Jde jen do úvodní věty, nikam se neukládá. */
  callerName?: string | null;
}): Promise<CallBriefing> {
  const [row] = await sql<
    {
      position: string | null;
      email: string;
      reason: string | null;
      priority: string | null;
      status: string | null;
      campaign_name: string | null;
      call_attempts: number | null;
      max_call_attempts: number | null;
      next_call_at: Date | null;
      qualification_criteria: string | null;
      script_opening: string | null;
      script_value: string | null;
      script_objections: string | null;
      script_closing: string | null;
    }[]
  >`
    select c.position, c.email,
           co.reason, co.priority, co.status,
           cp.name as campaign_name, cc.call_attempts, cp.max_call_attempts, cc.next_call_at,
           cp.qualification_criteria, cp.script_opening, cp.script_value,
           cp.script_objections, cp.script_closing
      from contacts c
      left join companies co on co.id = c.company_id
      left join campaign_contacts cc on cc.id = ${input.campaignContactId}::uuid
      left join campaigns cp on cp.id = cc.campaign_id
     where c.id = ${input.contactId}
  `;

  const [timeline, leadContext] = await Promise.all([
    input.campaignContactId ? getContactTimeline(input.campaignContactId) : [],
    // Během hovoru je to potřeba stejně jako před ním: caller se na Loom
    // nebo na poslední e-mail odvolává uprostřed věty a nesmí kvůli tomu
    // odejít z cockpitu na jinou obrazovku.
    getLeadContext({ contactId: input.contactId, campaignContactId: input.campaignContactId }),
  ]);

  const script = [
    { title: "Úvod", text: row?.script_opening },
    { title: "Hodnota / nabídka", text: row?.script_value },
    { title: "Námitky", text: row?.script_objections },
    { title: "Zakončení", text: row?.script_closing },
  ].filter((item): item is { title: string; text: string } => Boolean(item.text));

  return {
    position: row?.position ?? null,
    email: row?.email ?? null,
    reason: row?.reason ?? null,
    priorityLabel: row?.priority ? companyPriorityLabel(row.priority) : null,
    statusLabel: row?.status ? companyStatusLabel(row.status) : null,
    campaignName: row?.campaign_name ?? null,
    attempt: (row?.call_attempts ?? 0) + 1,
    maxAttempts: row?.max_call_attempts ?? null,
    qualification: row?.qualification_criteria ?? null,
    script,
    recent: timeline.slice(0, 3).map((entry) => ({
      id: entry.id,
      when: formatPast(entry.occurred_at),
      text:
        entry.kind === "call"
          ? `hovor — ${callOutcomeLabel(entry.title)}`
          : entry.kind === "reply"
            ? `odpověď — ${entry.title}`
            : `e-mail — ${entry.title}`,
    })),
    nextStep: row?.next_call_at ? `Zavolat · ${formatWhen(row.next_call_at)}` : null,
    context: toLeadContextView({
      whyNow: buildWhyNow(leadContext),
      loom: leadContext.loom,
      lastOutbound: leadContext.last_outbound,
      lastInbound: leadContext.last_inbound,
      opener: buildOpener({
        context: leadContext,
        contactName: null,
        companyName: null,
        callerName: input.callerName ?? null,
        campaignOpening: row?.script_opening ?? null,
      }),
    }),
  };
}
