import { notFound } from "next/navigation";
import { getMailbox } from "@/lib/queries/mailboxes";
import { PageHeader } from "@/components/ui";
import { MailboxForm } from "@/components/mailbox-form";

export const dynamic = "force-dynamic";

export default async function MailboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const mailbox = await getMailbox(id);
  if (!mailbox) notFound();

  return (
    <>
      <PageHeader title={mailbox.name} description={mailbox.from_email} />
      <div className="max-w-3xl">
        <MailboxForm
          values={{
            id: mailbox.id,
            name: mailbox.name,
            from_name: mailbox.from_name,
            from_email: mailbox.from_email,
            smtp_host: mailbox.smtp_host,
            smtp_port: mailbox.smtp_port,
            smtp_username: mailbox.smtp_username,
            smtp_secure: mailbox.smtp_secure,
            imap_host: mailbox.imap_host ?? "",
            imap_port: mailbox.imap_port ?? "",
            imap_username: mailbox.imap_username ?? "",
            imap_secure: mailbox.imap_secure,
          }}
        />
      </div>
    </>
  );
}
