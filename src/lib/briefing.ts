import { callOutcomeLabel } from "./calling";
import { formatWhen, isOverdue } from "./datetime";
import { getContactTimeline, type CallQueueRow } from "./queries/calling";
import { getCompanyContext } from "./queries/companies";
import { companyPriorityLabel, companyStatusLabel } from "./companies";
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
): Promise<CallBriefing> {
  const [company, timeline] = await Promise.all([
    getCompanyContext(prospect.company_id),
    getContactTimeline(prospect.id),
  ]);

  const recent = timeline.slice(0, 3).map((entry) => ({
    id: entry.id,
    when: formatWhen(entry.occurred_at),
    text:
      entry.kind === "call"
        ? `hovor — ${callOutcomeLabel(entry.title)}`
        : entry.kind === "reply"
          ? `odpověď — ${entry.title}`
          : `e-mail — ${entry.title}`,
  }));

  return {
    companyName: company?.name ?? prospect.company ?? null,
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
