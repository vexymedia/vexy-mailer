import Link from "next/link";
import { DateTime } from "./ui";
import { callOutcomeLabel } from "@/lib/calling";
import type { TimelineEntry, TimelineKind } from "@/lib/queries/calling";

/**
 * Jednotná historie firmy nebo kontaktu.
 *
 * Jeden řádek na událost, shora dolů od nejnovější. Caller sem chodí
 * s jedinou otázkou - "co se s touhle firmou už dělo" - a musí na ni
 * odpovědět jedním přejetím očima, ne čtením.
 */

const KIND_LABEL: Record<TimelineKind, string> = {
  outcome: "Výsledek hovoru",
  call: "Telefonát",
  email: "E-mail odeslán",
  reply: "Prospekt odpověděl",
  loom: "Loom odeslán",
};

const KIND_ACCENT: Record<TimelineKind, string> = {
  outcome: "border-l-sky-600",
  call: "border-l-sky-400",
  email: "border-l-zinc-300",
  reply: "border-l-emerald-500",
  loom: "border-l-violet-400",
};

/** Titulek události. Výsledek hovoru se ukládá jako kód, ne jako text. */
function title(entry: TimelineEntry): string {
  if (entry.kind === "outcome") return callOutcomeLabel(entry.title);
  return entry.title;
}

function linkLabel(kind: TimelineKind): string {
  if (kind === "loom") return "Otevřít video";
  return "Otevřít konverzaci";
}

export function ActivityTimeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <ol className="space-y-2">
      {entries.map((entry) => {
        const href = entry.href ?? null;
        // Loom vede ven z aplikace, zbytek dovnitř - a externí odkaz se
        // nesmí otevřít přes next/link.
        const external = entry.kind === "loom";
        return (
          <li
            key={`${entry.kind}-${entry.id}`}
            className={`card border-l-4 p-4 ${KIND_ACCENT[entry.kind]}`}
          >
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 text-sm">
                <span className="font-medium text-zinc-900">{KIND_LABEL[entry.kind]}</span>
                <span className="ml-2 text-zinc-700">{title(entry)}</span>
                {entry.status ? (
                  <span className="badge ml-2 bg-zinc-100 text-zinc-600 ring-zinc-200">
                    {entry.status}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                <DateTime value={entry.occurred_at} />
              </span>
            </div>

            <p className="text-xs text-zinc-500">
              {[entry.detail, entry.actor].filter(Boolean).join(" · ") || "—"}
            </p>

            {entry.note ? (
              <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">{entry.note}</p>
            ) : null}

            {href ? (
              external ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-2 inline-block text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-900"
                >
                  {linkLabel(entry.kind)}
                </a>
              ) : (
                <Link
                  href={href}
                  className="mt-2 inline-block text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-900"
                >
                  {linkLabel(entry.kind)}
                </Link>
              )
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
