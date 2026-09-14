import { formatPast } from "./datetime";

/**
 * Kontext leadu ve tvaru, ve kterém ho vykresluje UI.
 *
 * Vlastní modul bez JSX schválně: převod si ho vyžádá server (briefing),
 * a kdyby žil v komponentě, tahal by kvůli jednomu mapování celý
 * komponentový strom do serverového kódu i do testů.
 *
 * Časy se formátují tady, jednou, v pražské zóně - do klienta jde hotový
 * text, takže se nemůže po hydrataci rozejít.
 */

export interface LeadContextMessage {
  subject: string | null;
  snippet: string | null;
  when: string;
  href: string;
}

export interface LeadContextView {
  whyNow: string[];
  loom: { url: string; title: string | null; sentAt: string | null; note: string | null } | null;
  lastOutbound: LeadContextMessage | null;
  lastInbound: LeadContextMessage | null;
  opener: string | null;
}

export function toLeadContextView(input: {
  whyNow: string[];
  loom: { url: string; title: string | null; sent_at: Date | null; note: string | null } | null;
  lastOutbound: { conversation_id: string; subject: string | null; snippet: string | null; occurred_at: Date } | null;
  lastInbound: { conversation_id: string; subject: string | null; snippet: string | null; occurred_at: Date } | null;
  opener: string | null;
}): LeadContextView {
  const toMessage = (message: typeof input.lastOutbound): LeadContextMessage | null =>
    message
      ? {
          subject: message.subject,
          snippet: message.snippet,
          when: formatPast(message.occurred_at),
          href: `/inbox/${message.conversation_id}`,
        }
      : null;

  return {
    whyNow: input.whyNow,
    loom: input.loom
      ? {
          url: input.loom.url,
          title: input.loom.title,
          sentAt: input.loom.sent_at ? formatPast(input.loom.sent_at) : null,
          note: input.loom.note,
        }
      : null,
    lastOutbound: toMessage(input.lastOutbound),
    lastInbound: toMessage(input.lastInbound),
    opener: input.opener,
  };
}
