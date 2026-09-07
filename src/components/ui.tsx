import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{title}</h1>
        {description ? <p className="mt-1 text-sm text-zinc-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="card px-6 py-12 text-center">
      <p className="text-sm font-medium text-zinc-900">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500">{description}</p>
      {action ? (
        <Link href={action.href} className="btn-primary mt-4">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

const BADGE_STYLES: Record<string, string> = {
  // campaign
  draft: "bg-zinc-50 text-zinc-600 ring-zinc-200",
  active: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  paused: "bg-amber-50 text-amber-700 ring-amber-200",
  completed: "bg-blue-50 text-blue-700 ring-blue-200",
  // contact
  pending: "bg-zinc-50 text-zinc-600 ring-zinc-200",
  scheduled: "bg-sky-50 text-sky-700 ring-sky-200",
  sent: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  replied: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  failed: "bg-red-50 text-red-700 ring-red-200",
  unsubscribed: "bg-orange-50 text-orange-700 ring-orange-200",
  unknown: "bg-red-50 text-red-700 ring-red-200",
  skipped: "bg-zinc-50 text-zinc-500 ring-zinc-200",
};

export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-zinc-400">—</span>;
  return (
    <span className={`badge ${BADGE_STYLES[status] ?? "bg-zinc-50 text-zinc-600 ring-zinc-200"}`}>
      {status}
    </span>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "danger" | "good" }) {
  const toneClass =
    tone === "danger" ? "text-red-600" : tone === "good" ? "text-emerald-600" : "text-zinc-900";
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</dd>
    </div>
  );
}

/** Renders a timestamp in the browser's locale, with a stable server fallback. */
export function DateTime({ value, fallback = "—" }: { value: Date | string | null; fallback?: string }) {
  if (!value) return <span className="text-zinc-400">{fallback}</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()} className="tabular-nums">
      {date.toISOString().slice(0, 16).replace("T", " ")}
    </time>
  );
}

export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-zinc-200">
          <thead className="bg-zinc-50">{head}</thead>
          <tbody className="divide-y divide-zinc-100 bg-white">{children}</tbody>
        </table>
      </div>
    </div>
  );
}
