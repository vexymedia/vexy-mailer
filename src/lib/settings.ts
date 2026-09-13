import { sql } from "./db";
import type { AppSettings, TestBehavior } from "./types";

export async function getSettings(): Promise<AppSettings> {
  const [row] = await sql<AppSettings[]>`
    select test_mode, test_email, test_behavior, call_recording_enabled, updated_at
      from app_settings where id = true
  `;
  if (!row) {
    // The migration seeds this row; if it is gone, fail closed (test mode on).
    return {
      test_mode: true,
      test_email: null,
      test_behavior: "redirect",
      call_recording_enabled: true,
      updated_at: new Date(),
    };
  }
  return row;
}

export async function updateSettings(input: {
  test_mode: boolean;
  test_email: string | null;
  test_behavior: TestBehavior;
}): Promise<void> {
  await sql`
    update app_settings
       set test_mode = ${input.test_mode},
           test_email = ${input.test_email},
           test_behavior = ${input.test_behavior},
           updated_at = now()
     where id = true
  `;
}

/** Nahrávání hovorů je samostatný přepínač - nemá co dělat v testovacím režimu. */
export async function setCallRecordingEnabled(enabled: boolean): Promise<void> {
  await sql`
    update app_settings set call_recording_enabled = ${enabled}, updated_at = now() where id = true
  `;
}
