import type { CallOutcome, CallStatus, CallerCostModel, RevenueModel } from "./calling";

export type { CallOutcome, CallStatus, CallerCostModel, RevenueModel };

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
  daily_limit: number;
  timezone: string;
  enabled: boolean;
  last_send_at: Date | null;
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
  phone: string | null;
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
  /** @deprecated superseded by campaign_mailboxes; retained for history. */
  mailbox_id: string | null;
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

  // ---- calling. A campaign is e-mail AND phone; these are the phone half.
  calling_enabled: boolean;
  max_call_attempts: number;
  script_opening: string | null;
  script_value: string | null;
  script_objections: string | null;
  script_closing: string | null;
  qualification_criteria: string | null;
  revenue_model: RevenueModel;
  revenue_amount: number;
  caller_cost_model: CallerCostModel;
  caller_cost_amount: number;
  caller_hours: number;
  additional_costs: number;
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
  /** Sticky sender: set on the first send, never reassigned automatically. */
  sender_mailbox_id: string | null;

  // ---- calling. Deliberately parallel to, and never mixed with, the e-mail
  // fields above: `status` is the e-mail lifecycle, `call_status` the phone one.
  call_status: CallStatus;
  call_attempts: number;
  last_call_at: Date | null;
  next_call_at: Date | null;
  last_call_outcome: CallOutcome | null;
  call_note: string | null;
  assigned_caller_id: string | null;
  meeting_booked: boolean;
  meeting_at: Date | null;
  /** null = not judged yet. */
  meeting_qualified: boolean | null;
  meeting_held: boolean;
  deal_value: number | null;
}

export interface Caller {
  id: string;
  name: string;
  active: boolean;
  email: string | null;
  phone: string | null;
  created_at: Date;
}

export interface CallActivity {
  id: string;
  campaign_id: string;
  campaign_contact_id: string;
  contact_id: string;
  caller_id: string | null;
  outcome: CallOutcome;
  connected: boolean;
  note: string | null;
  attempt_number: number;
  called_at: Date;
  next_action_at: Date | null;
  meeting_at: Date | null;
  meeting_qualified: boolean | null;
  deal_value: number | null;
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
  mailbox_id: string | null;
}

// ------------------------------------------------------------- inbox

export type Classification =
  | "unclassified"
  | "positive"
  | "not_interested"
  | "later"
  | "wrong_person"
  | "ooo"
  | "unsubscribe"
  | "other";

export const CLASSIFICATIONS: { value: Classification; label: string }[] = [
  { value: "unclassified", label: "Nezařazeno" },
  { value: "positive", label: "Pozitivní" },
  { value: "not_interested", label: "Nemá zájem" },
  { value: "later", label: "Později" },
  { value: "wrong_person", label: "Špatná osoba" },
  { value: "ooo", label: "Mimo kancelář" },
  { value: "unsubscribe", label: "Odhlášení" },
  { value: "other", label: "Jiné" },
];

export interface ConversationRow {
  id: string;
  unread_count: number;
  classification: Classification;
  last_message_at: Date;
  last_inbound_at: Date | null;
  subject: string | null;
  contact_email: string;
  contact_name: string | null;
  company: string | null;
  campaign_name: string | null;
  campaign_id: string | null;
  mailbox_email: string;
  mailbox_id: string;
  /** The address the prospect actually replied to. */
  replied_to_email: string | null;
  message_count: number;
}

export interface ConversationDetail {
  id: string;
  classification: Classification;
  unread_count: number;
  subject: string | null;
  campaign_id: string | null;
  campaign_contact_id: string | null;
  contact_id: string;
  mailbox_id: string;
  contact_email: string;
  contact_name: string | null;
  company: string | null;
  website: string | null;
  campaign_name: string | null;
  mailbox_email: string;
  mailbox_from_name: string;
  mailbox_enabled: boolean;
  contact_status: CampaignContactStatus | null;
}

export interface MessageRow {
  id: string;
  direction: "outbound" | "inbound";
  kind: "campaign" | "manual_reply" | "incoming";
  from_email: string;
  to_email: string;
  subject: string | null;
  body_text: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  occurred_at: Date;
  is_read: boolean;
}
