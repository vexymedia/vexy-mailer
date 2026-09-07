import Link from "next/link";
import { listMailboxes } from "@/lib/queries/mailboxes";
import { PageHeader, Table, EmptyState, DateTime } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function MailboxesPage() {
  const mailboxes = await listMailboxes();

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="The accounts campaigns send from and watch for replies."
        actions={<Link href="/mailboxes/new" className="btn-primary">Add mailbox</Link>}
      />

      {mailboxes.length === 0 ? (
        <EmptyState
          title="No mailboxes yet"
          description="Add the SMTP and IMAP details of the account you want to send from."
          action={{ href: "/mailboxes/new", label: "Add mailbox" }}
        />
      ) : (
        <Table
          head={
            <tr>
              <th className="th">Mailbox</th>
              <th className="th">SMTP</th>
              <th className="th">IMAP</th>
              <th className="th">Connection</th>
              <th className="th">Last inbox check</th>
            </tr>
          }
        >
          {mailboxes.map((mailbox) => (
            <tr key={mailbox.id} className="hover:bg-zinc-50">
              <td className="td">
                <Link href={`/mailboxes/${mailbox.id}`} className="font-medium text-zinc-900 hover:underline">
                  {mailbox.name}
                </Link>
                <div className="text-xs text-zinc-500">{mailbox.from_name} &lt;{mailbox.from_email}&gt;</div>
              </td>
              <td className="td text-xs">{mailbox.smtp_host}:{mailbox.smtp_port}</td>
              <td className="td text-xs">
                {mailbox.imap_host ? `${mailbox.imap_host}:${mailbox.imap_port}` : (
                  <span className="text-amber-700">not configured</span>
                )}
              </td>
              <td className="td">
                {mailbox.last_test_ok === true ? (
                  <span className="badge bg-emerald-50 text-emerald-700 ring-emerald-200">ok</span>
                ) : mailbox.last_test_ok === false ? (
                  <span className="badge bg-red-50 text-red-700 ring-red-200">failed</span>
                ) : (
                  <span className="badge bg-zinc-50 text-zinc-600 ring-zinc-200">never tested</span>
                )}
                {mailbox.last_test_error ? (
                  <div className="mt-1 max-w-xs text-xs text-red-600">{mailbox.last_test_error}</div>
                ) : null}
              </td>
              <td className="td text-xs">
                <DateTime value={mailbox.imap_last_checked_at} fallback="never" />
                {mailbox.imap_last_error ? (
                  <div className="mt-1 max-w-xs text-red-600">{mailbox.imap_last_error}</div>
                ) : null}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
