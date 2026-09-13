import { sql } from "../db";
import { logActivity } from "../activity";
import { ACTIVITY_TYPE_LABELS, isoDate, addDays, type ActivityType } from "../plan";

export { ACTIVITY_TYPE_LABELS, isActivityType, startOfWeek, addDays, isoDate } from "../plan";
export type { ActivityType } from "../plan";

export interface WorkBlock {
  id: string;
  block_date: Date;
  start_minute: number;
  end_minute: number;
  caller_id: string | null;
  caller_name: string | null;
  activity_type: ActivityType;
  note: string | null;
}

export async function listWorkBlocks(weekStart: Date): Promise<WorkBlock[]> {
  const from = isoDate(weekStart);
  const to = isoDate(addDays(weekStart, 7));
  return sql<WorkBlock[]>`
    select wb.id, wb.block_date, wb.start_minute, wb.end_minute,
           wb.caller_id, cl.name as caller_name, wb.activity_type, wb.note
      from work_blocks wb
      left join callers cl on cl.id = wb.caller_id
     where wb.block_date >= ${from}::date and wb.block_date < ${to}::date
     order by wb.block_date, wb.start_minute, wb.id
  `;
}

export interface CreateWorkBlockInput {
  date: string;
  startMinute: number;
  endMinute: number;
  callerId: string | null;
  activityType: ActivityType;
  note: string | null;
}

export async function createWorkBlock(input: CreateWorkBlockInput): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into work_blocks (block_date, start_minute, end_minute, caller_id, activity_type, note)
    values (${input.date}::date, ${input.startMinute}, ${input.endMinute},
            ${input.callerId}, ${input.activityType}, ${input.note})
    returning id
  `;
  await logActivity({ action: "Pracovní blok naplánován", detail: `${input.date} · ${ACTIVITY_TYPE_LABELS[input.activityType]}` });
  return row.id;
}

export async function deleteWorkBlock(id: string): Promise<void> {
  await sql`delete from work_blocks where id = ${id}`;
  await logActivity({ action: "Pracovní blok smazán", level: "warn" });
}
