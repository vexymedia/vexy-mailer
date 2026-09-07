# Setting up SMTP and IMAP

The app sends through your own mailbox and watches the same mailbox for
replies. It needs both halves:

- **SMTP** — required. Without it nothing can be sent.
- **IMAP** — technically optional, but without it replies are never detected
  and people who have already answered keep receiving follow-ups. Configure it.

## Adding a mailbox

**Mailboxes → Add mailbox**, fill in both sections, save, then press
**Test connection**. The test verifies SMTP login and opens the IMAP INBOX
without sending anything.

A campaign will not start until its sender mailbox has passed this test at
least once.

### The identity fields

| Field | What it is |
| --- | --- |
| Label | Only shown inside this app |
| From name | The display name recipients see |
| From email | The address recipients see and reply to |

For most providers **From email must equal the SMTP username**. Sending as an
address you have not been authorised for is what SPF and DMARC exist to stop,
and it will land you in spam if it is delivered at all.

## Common providers

### Google Workspace / Gmail

| | Host | Port | TLS |
| --- | --- | --- | --- |
| SMTP | `smtp.gmail.com` | 587 | yes (STARTTLS) |
| IMAP | `imap.gmail.com` | 993 | yes |

Username is the full address. **The password must be an App Password, not your
account password** — Google blocks plain password authentication.

1. Enable 2-Step Verification on the account.
2. Go to <https://myaccount.google.com/apppasswords>.
3. Create one, and paste the 16 characters with the spaces removed.

Also enable IMAP: Gmail → Settings → *Forwarding and POP/IMAP* → *Enable IMAP*.

Google Workspace limits sending to roughly 2,000 messages a day, but that is
irrelevant here — for cold outreach from a new domain, stay under 50.

### Microsoft 365 / Outlook

| | Host | Port | TLS |
| --- | --- | --- | --- |
| SMTP | `smtp.office365.com` | 587 | yes (STARTTLS) |
| IMAP | `outlook.office365.com` | 993 | yes |

Microsoft has been disabling basic authentication for SMTP. If the connection
test fails with an authentication error, a tenant administrator must enable
*Authenticated SMTP* for the mailbox: **Microsoft 365 admin → Users → the user
→ Mail → Manage email apps → Authenticated SMTP**.

### Forpsi

| | Host | Port | TLS |
| --- | --- | --- | --- |
| SMTP | `smtp.forpsi.com` | 465 | yes (implicit) |
| IMAP | `imap.forpsi.com` | 993 | yes |

### Seznam.cz

| | Host | Port | TLS |
| --- | --- | --- | --- |
| SMTP | `smtp.seznam.cz` | 465 | yes (implicit) |
| IMAP | `imap.seznam.cz` | 993 | yes |

### Wedos

| | Host | Port | TLS |
| --- | --- | --- | --- |
| SMTP | `smtp.wedos.net` | 465 | yes (implicit) |
| IMAP | `imap.wedos.net` | 993 | yes |

### Anything else

Search for "*your provider* SMTP settings". You want the submission port (587
or 465), never port 25.

## Ports and TLS

Leave **Require TLS** on. Sending credentials over an unencrypted connection is
not worth the convenience.

- **Port 465** — implicit TLS. The connection is encrypted from the first byte.
- **Port 587** — STARTTLS. The connection opens in plaintext and is upgraded.

The app picks the right behaviour from the port automatically: 465 uses
implicit TLS, anything else demands a STARTTLS upgrade.

## How passwords are stored

Encrypted with AES-256-GCM using `ENCRYPTION_KEY`, before they reach the
database. The stored value looks like `v1:<iv>:<tag>:<ciphertext>`.

They are never sent back to the browser. Editing a mailbox and leaving the
password field blank keeps the stored one — the plaintext only ever travels
from your browser to the server, once.

GCM is authenticated, so a tampered ciphertext fails to decrypt rather than
producing garbage.

## How replies are detected

Every few minutes the worker opens INBOX for each mailbox and reads messages
newer than the last UID it saw. For each one it tries, in order:

1. **`In-Reply-To` against the `Message-ID` we generated.** Exact: it identifies
   the campaign, the contact and the step.
2. **The sender's address against your contacts.** Less precise, but it catches
   clients that strip threading headers.

On a match the contact is marked `replied`, `next_send_at` is cleared, and they
can no longer be picked up by the dispatcher. Nothing else in the sequence will
reach them.

Notes:

- Only INBOX is scanned. A reply filtered into another folder is missed, so do
  not add server-side rules that move replies out of the inbox.
- Mail from the mailbox's own address is ignored, so sent copies do not
  register as replies.
- On the first run the app looks back over roughly the last 200 messages rather
  than the whole history, then tracks UIDs from there.
- An out-of-office auto-reply counts as a reply and stops the sequence. That is
  usually what you want; if not, remove the `replied` status on that contact.

## Deliverability

Outside the scope of this tool, but it decides whether any of it works:

- **SPF, DKIM and DMARC** must be set up on the sending domain. Check at
  <https://www.mail-tester.com>.
- **Use a separate domain** for cold outreach, not the one your company email
  runs on. A domain that gets blacklisted takes everything on it down.
- **Warm the mailbox up** before volume sending. A brand-new address that sends
  50 cold emails on its first day is a spam signal. This app deliberately does
  not automate warm-up.
- **Keep the daily limit low.** 20–50 for a new mailbox.
- **Include a way out.** Put `{{unsubscribe_link}}` in your first email; the app
  also sets the `List-Unsubscribe` header automatically.

## When the connection test fails

| Message | Cause |
| --- | --- |
| `Invalid login` / `535` | Wrong password, or an app password is required |
| `ECONNECTION` / `ETIMEDOUT` | Wrong host or port, or a firewall in the way |
| `EDNS` / `ENOTFOUND` | The hostname does not resolve — check for a typo |
| `ETLS` / `wrong version number` | TLS mismatch: try 465 instead of 587, or the reverse |
| `Authenticated SMTP disabled` | Microsoft 365 — an admin must enable it |

The full error is stored on the mailbox and shown in the list, and every attempt
is recorded in the activity log.
