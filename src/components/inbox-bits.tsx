import { CLASSIFICATIONS, type Classification } from "@/lib/types";

const STYLES: Record<Classification, string> = {
  unclassified: "bg-zinc-50 text-zinc-600 ring-zinc-200",
  positive: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  not_interested: "bg-zinc-50 text-zinc-500 ring-zinc-200",
  later: "bg-amber-50 text-amber-700 ring-amber-200",
  wrong_person: "bg-orange-50 text-orange-700 ring-orange-200",
  ooo: "bg-sky-50 text-sky-700 ring-sky-200",
  unsubscribe: "bg-red-50 text-red-700 ring-red-200",
  other: "bg-zinc-50 text-zinc-600 ring-zinc-200",
};

export function ClassificationBadge({ value }: { value: Classification }) {
  const label = CLASSIFICATIONS.find((c) => c.value === value)?.label ?? value;
  return <span className={`badge ${STYLES[value]}`}>{label}</span>;
}
