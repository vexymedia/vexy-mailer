import { callOutcomeLabel } from "./calling";
import { formatPast, formatWhen, isOverdue } from "./datetime";
import { getContactTimeline, type CallQueueRow } from "./queries/calling";
import { getCompanyContext } from "./queries/companies";
import { buildOpener, buildWhyNow, getLeadContext } from "./queries/lead-context";
import { companyPriorityLabel, companyStatusLabel } from "./companies";
import { toLeadContextView } from "./lead-context-view";
import type { CallBriefing } from "@/components/call-workspace";

/**
 * Co caller potřebuje vidět, než vytočí číslo: proč firmu řešíme, co se s ní
 * už dělo a co má být dál.
 *
 * Sestavuje se na serveru a do klienta jde už naformátované. Časy tak vznikají
 * jednou, v pražské zóně, a nemůžou se po hydrataci rozejít.
 */
export async function buildCallBriefing(
  prospect: CallQueueRow,
  campaignName: string | null,
  options: { callerName?: string | null; campaignOpening?: string | null } = {},
): Promise<CallBriefing> {
  const [company, timeline, leadContext] = await Promise.all([
    getCompanyContext(prospect.company_id),
    getContactTimeline(prospect.id),
    getLeadContext({ contactId: prospect.contact_id, campaignContactId: prospect.id }),
  ]);

  const recent = timeline.slice(0, 3).map((entry) => ({
    id: entry.id,
    when: formatPast(entry.occurred_at),
    text:
      entry.kind === "call"
        ? `hovor — ${callOutcomeLabel(entry.title)}`
        : entry.kind === "reply"
          ? `odpověď — ${entry.title}`
          : `e-mail — ${entry.title}`,
  }));

  const contactName =
    [prospect.first_name, prospect.last_name].filter(Boolean).join(" ").trim() || null;

  return {
    companyName: company?.name ?? prospect.company ?? null,
    context: toLeadContextView({
      whyNow: buildWhyNow(leadContext),
      loom: leadContext.loom,
      lastOutbound: leadContext.last_outbound,
      lastInbound: leadContext.last_inbound,
      opener: buildOpener({
        context: leadContext,
        contactName,
        companyName: company?.name ?? prospect.company ?? null,
        callerName: options.callerName ?? null,
        campaignOpening: options.campaignOpening ?? null,
      }),
    }),
    reason: company?.reason ?? null,
    priority: company?.priority ?? null,
    priorityLabel: company ? companyPriorityLabel(company.priority) : null,
    statusLabel: company ? companyStatusLabel(company.status) : null,
    companyHref: prospect.company_id ? `/firmy/${prospect.company_id}` : null,
    campaignName,
    nextStep: prospect.next_call_at ? `Zavolat · ${formatWhen(prospect.next_call_at)}` : "Zavolat teď",
    nextStepOverdue: isOverdue(prospect.next_call_at),
    recent,
  };
}
