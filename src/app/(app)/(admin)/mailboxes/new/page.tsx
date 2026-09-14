import { PageHeader } from "@/components/ui";
import { MailboxForm } from "@/components/mailbox-form";

export const dynamic = "force-dynamic";

export default function NewMailboxPage() {
  return (
    <>
      <PageHeader title="Přidat schránku" />
      <div className="max-w-3xl">
        <MailboxForm
          values={{
            name: "",
            from_name: "",
            from_email: "",
            smtp_host: "",
            smtp_port: 465,
            smtp_username: "",
            smtp_secure: true,
            imap_host: "",
            imap_port: 993,
            imap_username: "",
            imap_secure: true,
            daily_limit: 40,
            mailbox_timezone: "Europe/Prague",
            enabled: true,
          }}
        />
      </div>
    </>
  );
}
