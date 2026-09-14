/**
 * Read-only audit jednoho hovoru.
 *
 * Nic nemění. Slouží k ověření, že konkrétní telefonát v produkci
 * odpovídá tomu, co ukazuje reporting - a hlavně jestli má přiřazeného
 * callera. Spouští se proti produkční DATABASE_URL:
 *
 *   DATABASE_URL=… node scripts/audit-call.mjs "Vojtěch" 2026-09-13
 */
import postgres from "postgres";
import { config } from "dotenv";

config({ path: ".env.local" });

const [needle = "", day = null] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Chybí DATABASE_URL.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

const rows = await sql`
  select c.id, c.provider_call_sid, c.status, c.started_at, c.answered_at, c.ended_at,
         c.duration_seconds, c.caller_id, cl.name as caller_name,
         c.recording_status, c.recording_sid, c.transcript_status, c.analysis_status,
         c.call_activity_id, c.campaign_contact_id, c.destination,
         coalesce(nullif(btrim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')), ''),
                  ct.email) as contact_name,
         co.name as company_name,
         ca.outcome
    from calls c
    join contacts ct on ct.id = c.contact_id
    left join callers cl on cl.id = c.caller_id
    left join companies co on co.id = c.company_id
    left join call_activities ca on ca.id = c.call_activity_id
   where (${needle} = '' or ct.first_name ilike ${"%" + needle + "%"}
          or ct.last_name ilike ${"%" + needle + "%"}
          or ct.email ilike ${"%" + needle + "%"})
     and (${day}::date is null or c.started_at::date = ${day}::date)
   order by c.started_at desc
   limit 20
`;

if (rows.length === 0) {
  console.log("Žádný hovor neodpovídá zadání.");
} else {
  for (const row of rows) {
    console.log("─".repeat(70));
    console.log(`business call id : ${row.id}`);
    console.log(`twilio call sid  : ${row.provider_call_sid ?? "— (nikdy se nevytáčelo)"}`);
    console.log(`kontakt / firma  : ${row.contact_name} · ${row.company_name ?? "bez firmy"}`);
    console.log(`číslo            : ${row.destination}`);
    console.log(`stav             : ${row.status}`);
    console.log(`spojeno          : ${row.answered_at ? "ANO · " + row.answered_at.toISOString() : "NE"}`);
    console.log(`délka            : ${row.duration_seconds ?? "—"} s`);
    console.log(`caller           : ${row.caller_name ?? "!! BEZ ATTRIBUTION (caller_id je null)"}`);
    console.log(`nahrávka         : ${row.recording_status} ${row.recording_sid ?? ""}`);
    console.log(`přepis / analýza : ${row.transcript_status} / ${row.analysis_status}`);
    console.log(`výsledek         : ${row.outcome ?? "!! nezapsaný"}`);
    console.log(`v kampani        : ${row.campaign_contact_id ? "ano" : "ne (ad-hoc)"}`);
    console.log(`počítá se jako   : ${row.provider_call_sid ? "1 pokus" : "0 pokusů"}` +
                `${row.answered_at ? " + 1 spojený" : ""}`);
  }
}

await sql.end();
