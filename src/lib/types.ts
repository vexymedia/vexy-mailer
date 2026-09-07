export type CampaignStatus = "draft" | "active" | "paused" | "completed";

export type CampaignContactStatus =
  | "pending"
  | "scheduled"
  | "sent"
  | "replied"
  | "completed"
  | "failed"
  | "unsubscribed";

export type SendStatus = "sending" | "sent" | "failed" | "unknown" | "skipped";

export type LogLevel = "info" | "warn" | "error";

export type TestBehavior = "redirect" | "simulate";

export interface AppSettings {
  test_mode: boolean;
  test_email: string | null;
  test_behavior: TestBehavior;
  updated_at: Date;
}

export interface Mailbox {
  id: string;
  name: string;
  from_name: string;
  from_email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_password_enc: string;
  smtp_secure: boolean;
  imap_host: string | null;
  imap_port: number | null;
  imap_username: string | null;
  imap_password_enc: string | null;
  imap_secure: boolean;
  imap_last_uid: string | null;
  imap_uidvalidity: string | null;
  imap_last_checked_at: Date | null;
  imap_last_error: string | null;
  last_test_ok: boolean | null;
  last_test_at: Date | null;
  last_test_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Contact {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  website: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Campaign {
  id: string;
  name: string;
  mailbox_id: string;
  status: CampaignStatus;
  daily_limit: number;
  send_days: number[];
  send_start_minute: number;
  send_end_minute: number;
  timezone: string;
  next_slot_at: Date | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface SequenceStep {
  id: string;
  campaign_id: string;
  step_number: number;
  delay_days: number;
  subject: string;
  body: string;
}

export interface CampaignContact {
  id: string;
  campaign_id: string;
  contact_id: string;
  status: CampaignContactStatus;
  current_step: number;
  next_send_at: Date | null;
  last_sent_at: Date | null;
  replied_at: Date | null;
  completed_at: Date | null;
  last_error: string | null;
  thread_message_id: string | null;
}

export interface EmailSend {
  id: string;
  campaign_id: string;
  campaign_contact_id: string;
  step_id: string;
  step_number: number;
  status: SendStatus;
  to_email: string;
  intended_email: string;
  subject: string;
  body: string;
  message_id: string | null;
  attempt_count: number;
  error: string | null;
  next_retry_at: Date | null;
  claimed_at: Date;
  sent_at: Date | null;
}
