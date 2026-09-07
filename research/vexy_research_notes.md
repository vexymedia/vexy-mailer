# VEXY prospect research — working notes

Research for VEXY, an external B2B outbound / appointment-setting team selling
booked meetings, targeting CZ/SK companies where a fee of roughly 25–60k CZK
per month is economically defensible.

---

## ⚠️ Read this before using the CSV

**No company website could be opened during this research.** `WebFetch` and
`curl` are both refused by the network egress proxy in this environment (HTTP
403 — an organisation policy, not a transient failure). Wikipedia is blocked
too, so it is not domain-specific.

Only `WebSearch` worked, because it runs server-side rather than through this
container's network.

The practical consequences, stated plainly:

| Normally | Here |
| --- | --- |
| Open the contact page, read the published address | Impossible |
| Confirm a decision maker on the team page | Impossible |
| Verify a company still sells what it claims | Only via a search summary |
| Score REACHABILITY 13–15 (named DM + public direct email) | Never justified |

So **every row in the CSV is a research lead, not a verified prospect.** Almost
all emails are `INFERRED_NOT_VERIFIED`, derived from the domain seen in a search
result URL. Not one was read off a page.

**Nothing here should be emailed before a human verification pass.** Sending to
inferred addresses at volume produces bounces, and bounces damage domain
reputation — which the project's own pre-flight checklist warns about.

### Verification pass required before any send

1. Open the company site and confirm it still sells what the CSV says.
2. Read the real contact/team page; replace the inferred email with the
   published one and set `email_status` to `PUBLIC_DIRECT` / `PUBLIC_GENERIC`.
3. Confirm the decision maker's name and current role on the company's own site
   or LinkedIn — **not** on an aggregator.
4. Drop any row whose email cannot be confirmed.
5. Re-score REACHABILITY once real contacts exist; most scores will move.

Two rows carry a stronger warning in `notes`: **Roger** and **BOOTIQ** have
domains I guessed rather than saw in a result URL. Confirm those first.

---

## Counts

| | |
| --- | --- |
| Segments explored | 7 |
| Candidate companies surfaced | ~35 |
| Companies written to the CSV | 18 |
| With a published email actually seen in a result | 1 (KARAT, `info@`, via search summary) |
| With a named decision maker | 1 (KARAT — from an aggregator, unverified) |
| Verified by opening a page | **0** |

Deduplicated by domain. Bank-owned factoring arms (Česká spořitelna, ČSOB, KB,
Raiffeisen, UniCredit) were surfaced and deliberately excluded: local management
at a bank subsidiary is unlikely to be able to buy a service like this.

---

## Segment findings

### 1. Cybersecurity / NIS2 compliance — best timing signal found
The only segment with a hard, dated, external trigger. Act 264/2025 on cyber
security is in its implementation window and act 266/2026 covers critical
infrastructure; the EU Cyber Resilience Act starts biting from H2 2026. A cited
survey found 79% of firms struggle to evaluate security vendors and only 5% of
IT managers fully trust their current one — a crowded market where *reach*
decides, which is exactly what VEXY sells. Vendors here have a large, legally
compelled, time-boxed buyer pool.
Only one concrete vendor (SecureOn) surfaced; this segment deserves a dedicated
research pass.

### 2. ERP / WMS / MES vendors — strongest structural fit
Textbook VEXY economics: six-figure deals, demo-led sales, a definable list of
manufacturers and distributors, and long customer lifetimes. Czech-owned mid-size
vendors (KARAT, KVADOS, GRiT) are the sweet spot. The large ones — Asseco/Helios,
ABRA — are probably too corporate for a nimble external team.

### 3. Industrial automation / robotics integrators — deep pool, weak signals
The largest pool by count and consistently good economics (projects worth
millions of CZK, technical meeting-led sales, owner-led firms with no
prospecting function). What is missing is timing: none published a visible
trigger. B:TECH's heavy automotive concentration is the most interesting angle —
diversification pressure is a real reason to start outbound.

### 4. Factoring / B2B financing — good economics, real market signal
The Czech factoring market grew **27.2% year on year in H1**, against roughly 10%
across Europe. Recurring revenue, high LTV, CFO buyer. The catch is that the
market is dominated by bank subsidiaries; only the independents (ARFIN, Roger,
Bibby) are plausible buyers.

### 5. Custom software / digital agencies — best single trigger
BOOTIQ is actively hiring a Business Development Manager whose posted
description explicitly requires cold email, LinkedIn and phone outreach turned
into first meetings. That is a company telling you, in public, that it has
decided to buy exactly what VEXY does — and is about to spend six months
building it in-house instead.
**This pattern is the single most productive search VEXY can run**: companies
advertising for an SDR/BDM are pre-qualified buyers.

### 6. Recruitment / executive search — good economics, awkward fit
High fees, C-level buyers, continuous need for new clients. But recruiters
often already run outbound and may read VEXY as a competitor rather than a
supplier. Expect a higher objection rate. Worth testing, not worth leading with.

### 7. Segments that look weak
- **Bank-owned financial services** — no local buying autonomy.
- **Large ERP incumbents** (Asseco/Helios, ABRA) — corporate procurement.
- Anything B2C, e-commerce or commodity, per the brief.

---

## Recommended first test

**Companies hiring SDRs / BDMs / Sales Managers**, cutting across every segment
rather than sitting inside one. The reasoning:

- The trigger is explicit, dated and public — no inference needed.
- It proves budget exists: they are already committing a salary to this job.
- The pitch writes itself: *"you are three months and one hiring risk away from
  what we can start on Monday."*
- It is trivially repeatable from job boards (StartupJobs, Indeed, Jooble,
  LinkedIn), which is the kind of list that can be rebuilt weekly.

Second: **cybersecurity vendors**, while the NIS2 implementation window is open.
The deadline does the persuading.

Third: **mid-size Czech ERP/WMS vendors**, as the steady evergreen base.

---

## What a follow-up pass should do

1. Re-run this with page access, so contacts can actually be verified.
2. Mine job boards systematically for SDR/BDM/Head of Sales postings — the
   highest-yield source found here, and the one least dependent on guesswork.
3. Push into segments this pass barely touched: MES specifically, machine
   vision, intralogistics, industrial energy, AI/data consultancies, and the
   Slovak market, which was not reached at all.
