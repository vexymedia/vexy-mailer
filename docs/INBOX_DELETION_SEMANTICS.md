# What deleting things does to the Inbox

The unified inbox spans several tables, and it is not obvious which deletions
reach it. This documents the rules deliberately, because the alternative -
cascading everything - would destroy the record of who has already been emailed.

## The two tables people confuse

| Table | What it is |
| --- | --- |
| `replies` | The **IMAP detection ledger**. One row per message the poller matched, used to avoid processing the same message twice. |
| `messages` | The **conversation record**. Every email in the thread, in both directions, including the ones we sent. |

`messages.reply_id` is a convenience link between them, declared
`ON DELETE SET NULL`.

## The rules

**1. Deleting a reply does not delete conversation history.**

Removing a row from `replies` detaches the link and leaves the message. This is
deliberate: the conversation contains the outbound emails too, and destroying
that to tidy a ledger row would be data loss. If you delete every historical
reply, the inbox keeps showing those conversations — that is working as
intended, not a bug.

**2. A conversation is listed only while it still has an inbound message.**

Visibility is computed from the messages that actually exist, not from the
denormalised `conversations.last_inbound_at`. Nothing recomputes that column
when messages are deleted, so a conversation whose inbound messages were all
removed used to linger in the inbox with nothing in it. It no longer does.

A conversation that has only ever had outbound messages — a campaign send to
someone who has not answered — is not in the inbox either. The inbox is for
replies.

**3. Deleting a campaign does not hide the conversation.**

`conversations.campaign_id` and `campaign_contact_id` are `ON DELETE SET NULL`.
The exchange still happened and the prospect still wrote to you, so the thread
stays and is shown as **no campaign**. Hiding real correspondence because a
campaign record was tidied away would lose more than it saves.

**4. Deleting a contact removes their conversation.**

`conversations.contact_id` is `ON DELETE CASCADE`. A conversation is defined as
being *with* that contact, so it cannot outlive them. Note this does not remove
`email_sends` — the sending ledger is keyed on `campaign_contacts` and survives,
which is what keeps a deleted-and-reimported contact from being emailed the
same step twice.

**5. Removing a conversation is an explicit action.**

**Inbox → conversation → Delete conversation.** It deletes the conversation and
its messages and nothing else. Contacts, campaign contacts, `email_sends` and
`replies` are all left intact.

This exists because no other deletion reaches a conversation, so without it an
operator has no safe way to clear a stale thread — which is exactly the state
QA hit after deleting old replies.

## What this means in practice

| You want to… | Do this |
| --- | --- |
| Clear one stale thread from the inbox | Delete conversation, on the thread |
| Stop contacting someone | Do not contact — never deletion |
| Remove test data after a QA run | Delete the conversations, then the contacts |
| Free up a mailbox's daily quota | Nothing here helps; quota is counted on `email_sends` |

**Deleting things never makes someone eligible to be emailed again.** That is
governed by `email_sends`, which none of these paths touch except the contact
cascade, and even then the ledger rows survive.
