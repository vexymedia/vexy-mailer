import { sql } from "../db";
import { logActivity } from "../activity";

/**
 * Klienti a přidělení práce.
 *
 * Klient je nejmenší struktura, která dělá provoz jednoznačným: kampaň
 * pod něj patří a všechno ostatní (kontakty v kampani, hovory, výsledky,
 * konverzace) se ke klientovi dohledá přes ni. Vlastní `client_id` se
 * proto nekopíruje do dalších tabulek - byla by to jen další věc, která
 * se může rozejít.
 */

export interface Client {
  id: string;
  name: string;
  active: boolean;
  created_at: Date;
}

export interface ClientRow extends Client {
  campaigns: number;
}

export async function listClients(options: { activeOnly?: boolean } = {}): Promise<ClientRow[]> {
  return sql<ClientRow[]>`
    select c.id, c.name, c.active, c.created_at,
           (select count(*)::int from campaigns cp where cp.client_id = c.id) as campaigns
      from clients c
     where (${options.activeOnly ?? false} = false or c.active)
     order by c.active desc, c.name
  `;
}

export async function getClient(id: string): Promise<Client | null> {
  const [row] = await sql<Client[]>`select id, name, active, created_at from clients where id = ${id}`;
  return row ?? null;
}

export type ClientWriteResult =
  | { ok: true; id: string }
  | { ok: false; error: "duplicate" | "empty_name" | "not_found" };

export async function createClient(name: string): Promise<ClientWriteResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "empty_name" };

  const [clash] = await sql<{ id: string }[]>`
    select id from clients where lower(name) = ${trimmed.toLowerCase()}
  `;
  if (clash) return { ok: false, error: "duplicate" };

  const [row] = await sql<{ id: string }[]>`
    insert into clients (name) values (${trimmed}) returning id
  `;
  await logActivity({ action: "Klient přidán", detail: trimmed });
  return { ok: true, id: row.id };
}

/**
 * Kampaně, na kterých caller smí pracovat.
 *
 * Jediný zdroj pravdy pro rozsah jeho práce. Vrací se id, protože se tím
 * filtrují fronty i přístup k jednotlivým záznamům.
 */
export async function callerCampaignIds(callerId: string): Promise<string[]> {
  const rows = await sql<{ campaign_id: string }[]>`
    select campaign_id from caller_campaigns where caller_id = ${callerId}
  `;
  return rows.map((row) => row.campaign_id);
}

export interface CampaignAssignment {
  campaign_id: string;
  campaign_name: string;
  client_id: string | null;
  client_name: string | null;
  assigned: boolean;
}

/** Kampaně a zaškrtnutí, které z nich caller zpracovává. */
export async function listAssignments(callerId: string): Promise<CampaignAssignment[]> {
  return sql<CampaignAssignment[]>`
    select cp.id as campaign_id, cp.name as campaign_name,
           cp.client_id, cl.name as client_name,
           exists (select 1 from caller_campaigns cc
                    where cc.caller_id = ${callerId} and cc.campaign_id = cp.id) as assigned
      from campaigns cp
      left join clients cl on cl.id = cp.client_id
     where cp.status <> 'completed'
     order by cl.name nulls last, cp.name
  `;
}

/**
 * Přepíše přidělení jedním zápisem.
 *
 * Celý seznam, ne přírůstky: formulář posílá stav zaškrtávátek a rozdíl
 * by se musel počítat na dvou místech.
 */
export async function setAssignments(callerId: string, campaignIds: string[]): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from caller_campaigns where caller_id = ${callerId}`;
    if (campaignIds.length > 0) {
      await tx`
        insert into caller_campaigns ${tx(
          campaignIds.map((campaignId) => ({ caller_id: callerId, campaign_id: campaignId })),
        )}
        on conflict do nothing
      `;
    }
  });
  await logActivity({
    action: "Přidělení kampaní změněno",
    detail: `${campaignIds.length} kampaní`,
  });
}

/**
 * Smí caller pracovat s tímhle kontaktem?
 *
 * Ptá se na kontakt, ne na kampaň, protože právě tak vypadá útok: znám
 * id kontaktu z jiného klienta a zkusím ho vytočit. Stačí, aby kontakt
 * byl v některé z přidělených kampaní.
 */
export async function callerMayWorkWithContact(
  callerId: string,
  contactId: string,
): Promise<boolean> {
  const [row] = await sql<{ allowed: boolean }[]>`
    select exists (
      select 1
        from campaign_contacts cc
        join caller_campaigns ca on ca.campaign_id = cc.campaign_id
       where cc.contact_id = ${contactId} and ca.caller_id = ${callerId}
    ) as allowed
  `;
  return row?.allowed ?? false;
}

/** Smí caller vidět tuhle konverzaci? Stejné pravidlo přes kontakt. */
export async function callerMaySeeConversation(
  callerId: string,
  conversationId: string,
): Promise<boolean> {
  const [row] = await sql<{ allowed: boolean }[]>`
    select exists (
      select 1
        from conversations cv
        join campaign_contacts cc on cc.contact_id = cv.contact_id
        join caller_campaigns ca on ca.campaign_id = cc.campaign_id
       where cv.id = ${conversationId} and ca.caller_id = ${callerId}
    ) as allowed
  `;
  return row?.allowed ?? false;
}

/**
 * Přidělení pro celý tým najednou.
 *
 * Stránka Tým vykresluje řádek na člověka a dotaz na každého zvlášť by
 * byl N+1 bez důvodu - kampaní je málo a vejdou se do jednoho výsledku.
 */
export async function listAllAssignments(): Promise<Map<string, CampaignAssignment[]>> {
  const rows = await sql<(CampaignAssignment & { caller_id: string })[]>`
    select cl.id as caller_id,
           cp.id as campaign_id, cp.name as campaign_name,
           cp.client_id, cli.name as client_name,
           exists (select 1 from caller_campaigns ca
                    where ca.caller_id = cl.id and ca.campaign_id = cp.id) as assigned
      from callers cl
      cross join campaigns cp
      left join clients cli on cli.id = cp.client_id
     where cp.status <> 'completed'
     order by cli.name nulls last, cp.name
  `;

  const result = new Map<string, CampaignAssignment[]>();
  for (const row of rows) {
    const list = result.get(row.caller_id) ?? [];
    list.push({
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      client_id: row.client_id,
      client_name: row.client_name,
      assigned: row.assigned,
    });
    result.set(row.caller_id, list);
  }
  return result;
}
