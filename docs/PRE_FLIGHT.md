# Before your first real campaign

Work through this once, properly. Most of it takes ten minutes; the rehearsal
in section 5 takes a day and is the one worth not skipping.

Cold email is unusual in that mistakes are unrecoverable. You cannot unsend to
200 people.

---

## 1. Infrastructure

- [ ] `npm run db:migrate` has been run against the **production** database.
- [ ] This returns `email_sends_campaign_contact_id_step_id_key`:
      ```sql
      select conname from pg_constraint
       where conrelid = 'email_sends'::regclass and contype = 'u';
      ```
      That index is what makes a duplicate send impossible. If it is missing,
      stop.
- [ ] `ENCRYPTION_KEY` is backed up somewhere outside the deployment. Losing it
      means re-entering every mailbox password.
- [ ] `APP_URL` is set to the production URL, not a preview one.
- [ ] `APP_PASSWORD` is not something guessable. The app is on the public
      internet.

## 2. The worker

- [ ] The cron is listed and firing (Vercel → Cron Jobs, or your scheduler's
      history).
- [ ] Called without the secret, the endpoint returns `401`:
      ```bash
      curl -i -X POST https://your-app.vercel.app/api/cron/tick
      ```
- [ ] Called with it, it returns `"ok": true`.
- [ ] **Run worker now** on the dashboard reports something sensible.

## 3. The mailbox

- [ ] **Test connection** passes for both SMTP *and* IMAP. SMTP alone means
      replies are never detected and people who answer keep being chased.
- [ ] The From address equals the SMTP username.
- [ ] SPF, DKIM and DMARC are configured for the sending domain. Verify at
      <https://www.mail-tester.com> — aim for 9/10 or better.
- [ ] The mailbox has been warmed up: it has been sending and receiving ordinary
      mail for at least a couple of weeks. A brand-new address that sends 50
      cold emails on day one is a spam signal.
- [ ] It is **not** the mailbox your business depends on. Use a separate
      domain, so a blacklisting does not take your real email down with it.
- [ ] No server-side rule moves replies out of INBOX — only INBOX is scanned.

## 4. The campaign

- [ ] The contact list is one you can defend having. Under GDPR, cold B2B email
      needs a legitimate interest that you could explain to the recipient.
- [ ] The CSV imported cleanly. Read the import warnings; they name every
      skipped row and every ignored column.
- [ ] Spot-check five contacts in the Contacts table. Is `first_name` really a
      first name, or is it `"Ing. Jan Novák, MBA"`?
- [ ] Every step's subject and body render correctly. Preview them mentally
      against a contact with a **missing** company or first name — use
      `{{first_name|there}}` rather than shipping `Ahoj ,`.
- [ ] No unknown variables. The editor flags them as you type; `{{comapny}}`
      silently renders as nothing.
- [ ] The daily limit is low. **20–50** for a new mailbox, whatever the list
      size.
- [ ] The sending window is working hours in the **recipients'** timezone, and
      the timezone field says what you think it does.
- [ ] Weekends are off unless you have a reason.
- [ ] Follow-up delays are realistic. 3 and 4 days are sensible; 1 day is
      badgering.
- [ ] The first email contains `{{unsubscribe_link}}`.
- [ ] Anyone you must not contact — existing customers, people who have asked
      before — is on the **Do not contact** list *already*. Adding an address
      there blocks it permanently, including from every future campaign.

## 5. The rehearsal

**Do not skip this.**

- [ ] Test mode is **on**, set to **Redirect**, with your own address in it.
      Confirm the amber banner at the top of every page says so.
- [ ] Start the campaign and let the worker run.
- [ ] An email arrives in your inbox with the subject prefixed
      `[TEST -> someone@theircompany.com]`.
- [ ] Read it as a recipient would. Are the variables filled in? Does it read
      like a person wrote it?
- [ ] Click the unsubscribe link. It must show a **confirmation page with a
      button**, not unsubscribe you on the spot - opening the link is not a
      decision, pressing the button is. Press it and confirm the address lands
      on the **Do not contact** list.
- [ ] Check the From name and address in your mail client's header.
- [ ] Reply to it from a *different* address that is in the list, wait for the
      next IMAP poll, and confirm that contact flips to **replied** and its
      *Next email* becomes empty.
- [ ] Leave it running for a few hours. Confirm on the Activity page that emails
      are spread out by several minutes each, not sent in a burst.
- [ ] Confirm the daily limit is respected: once it is reached the dashboard
      shows `n/n of today's limit used` and nothing further goes out.
- [ ] Pause the campaign. Confirm nothing more is sent.

Then reset for the real thing: delete the test campaign, or pause it and clear
its `email_sends` rows, so the rehearsal does not consume real steps.

## 6. Going live

- [ ] Everything above is ticked.
- [ ] **Settings → turn test mode off.** Confirm the banner turns red and reads
      `LIVE SENDING`.
- [ ] Start the campaign.
- [ ] Watch the first three sends land in Activity. Confirm the recipients are
      real contacts and the daily counter is climbing.
- [ ] Check your own inbox for bounces after an hour.

## 7. The first week

- [ ] Check the dashboard daily.
- [ ] **Needs review above zero** means one or more sends have an unknown
      outcome — the worker was interrupted mid-send and we cannot tell whether
      the message left. They are never retried automatically. Open the campaign,
      decide per contact, and use *Skip step* to resume the sequence.
- [ ] **Failed climbing** usually means an SMTP problem. The activity log has
      the server's own words.
- [ ] **Replies at zero after 30+ sends** — check that IMAP is actually polling
      (Mailboxes → *Last inbox check*). A stale timestamp means reply detection
      is broken and you are chasing people who already answered.
- [ ] **Bounces above ~5%** — stop and clean the list. High bounce rates damage
      domain reputation quickly.
- [ ] Add every "not interested" to **Do not contact**. It costs nothing and
      protects you from contacting them again in six months.

---

## If something goes wrong

**Stop everything:** pause each active campaign, or turn test mode back on —
that alone prevents any further email reaching a real person, immediately, on
the next tick.

**Did an email go out twice?** It should be impossible, but check:

```sql
select campaign_contact_id, step_id, count(*)
  from email_sends
 group by 1, 2 having count(*) > 1;
```

This must return zero rows. If it ever does not, the unique index is missing
from that database.

**What was actually sent to whom:**

```sql
select es.sent_at, es.intended_email, es.to_email, es.step_number, es.status, es.subject
  from email_sends es
 where es.campaign_id = '...'
 order by es.sent_at desc;
```

`to_email` is where it really went; `intended_email` is who it was for. They
differ only in redirect test mode.

---

## Before your first calling campaign

Calling has no equivalent of the unsend problem — a call that goes badly is
recoverable — so this is much shorter. It is still worth ten minutes.

- [ ] `npm run db:migrate` has applied `0003_calling.sql` to the production
      database. This returns one row:
      ```sql
      select to_regclass('public.call_activities') as t, to_regclass('public.callers') as c;
      ```
- [ ] The contacts actually have phone numbers. A contact without one is never
      offered to a caller and silently sits out the campaign:
      ```sql
      select count(*) filter (where c.phone is null or btrim(c.phone) = '') as no_phone,
             count(*) as total
        from campaign_contacts cc join contacts c on c.id = cc.contact_id
       where cc.campaign_id = '...';
      ```
- [ ] Every caller who will work today exists under **Calleři** and is active.
      A call logged with nobody selected is attributed to no one, and the
      per-caller numbers will not add up.
- [ ] The campaign has **Volání zapnuto**, an attempt limit you meant, and a
      script the caller can actually read aloud.
- [ ] **Kritéria kvalifikace** are filled in. They are shown to the caller at
      the moment they book a meeting and they decide what is billable. An empty
      box means every judgement is a guess.
- [ ] The economics on the campaign match the deal you actually signed: the
      right revenue model and rate, and the right caller cost model. Check one
      number by hand before trusting the tab — for a campaign billed at 40 Kč
      per connected call, 125 connected calls must read 5 000 Kč.
- [ ] Walk one prospect through the workspace yourself: dial, log an outcome,
      confirm the next contact loads, and confirm the attempt counter moved on
      the campaign's **Volání** tab.

### Watch for

**Meetings nobody has judged.** The Volání tab says so in an amber banner.
Every unjudged meeting is revenue you cannot invoice:

```sql
select count(*) from campaign_contacts
 where campaign_id = '...' and meeting_booked and meeting_qualified is null;
```

**Prospects who ran out of attempts without ever being reached.** A large
`max_attempts` count next to a small connected count usually means the phone
numbers are wrong, not that the market is cold:

```sql
select call_status, count(*) from campaign_contacts
 where campaign_id = '...' group by 1 order by 2 desc;
```

**Calling does not stop e-mails.** A `do_not_call` outcome is about the phone
only: it does not add anyone to the do-not-contact list and does not pause the
sequence. If someone asks for both, suppress them under **Nekontaktovat** as
well — that is the switch that stops e-mail.
