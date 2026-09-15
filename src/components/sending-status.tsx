import type { SendingStatus } from "@/lib/queries/sending-status";

/**
 * Stav odesílání kampaně pro dnešek.
 *
 * Šest čísel a případný problém. Ne dashboard - odpověď na "kolik dnes
 * ještě odejde, co na to čeká a je něco rozbité". Cíle jsou označené
 * vlnovkou schválně: 70/30 je cílové rozdělení, ne přepážka, a tvrdit
 * jinak by mátlo pokaždé, když se kapacita přelije.
 */
function Cell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-900">{value}</dd>
      {hint ? <dd className="text-xs text-zinc-500">{hint}</dd> : null}
    </div>
  );
}

export function SendingStatusPanel({ status }: { status: SendingStatus }) {
  return (
    <div className="card p-5">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">Dnes</h2>
        <span className="text-sm tabular-nums text-zinc-600">
          {status.sentToday} / {status.dailyLimit} odesláno
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        <Cell
          label="Nové"
          value={`${status.sentNew} / ~${status.targetNew}`}
          hint={`${status.waitingNew} čeká`}
        />
        <Cell
          label="Follow-up"
          value={`${status.sentFollowUp} / ~${status.targetFollowUp}`}
          hint={`${status.dueFollowUps} splatných`}
        />
        <Cell
          label="Po termínu"
          value={String(status.overdueFollowUps)}
          hint={status.overdueFollowUps > 0 ? "jdou na řadu první" : undefined}
        />
        <Cell label="Čeká nových" value={String(status.waitingNew)} />
        <Cell
          label="Schránky"
          value={`${status.mailboxesActive} / ${status.mailboxesTotal}`}
          hint="aktivních"
        />
        <Cell label="Podíl nových" value={`${status.newRatio} %`} />
      </dl>

      {status.problems.length > 0 ? (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">
            {status.problems.length === 1
              ? "1 schránka vyžaduje pozornost"
              : `${status.problems.length} schránky vyžadují pozornost`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {status.problems.map((p) => (
              <li key={p.from_email} className="text-xs text-amber-900">
                <span className="font-medium">{p.from_email}</span> — {p.problem}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {status.backlogWarning ? (
        <p className="mt-3 rounded-md bg-zinc-50 px-4 py-2 text-xs text-zinc-700">
          {status.backlogWarning}
        </p>
      ) : null}
    </div>
  );
}
