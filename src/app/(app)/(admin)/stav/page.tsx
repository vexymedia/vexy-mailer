import { getSystemStatus, type StatusLevel, type SubsystemStatus } from "@/lib/system-status";
import { PageHeader, DateTime } from "@/components/ui";
import { NastaveniTabs } from "@/components/section-tabs";

export const dynamic = "force-dynamic";

/**
 * Stav systému.
 *
 * Odpověď na otázku, kterou dřív šlo zodpovědět jen z terminálu: je tohle
 * nasazení použitelné, a když ne, co přesně chybí. Není to dashboard ani
 * monitoring - je to seznam, který se čte shora dolů a u každé položky
 * říká, co s tím.
 *
 * Nic odsud nejde spustit. Tlačítko „oprav databázi" tu schválně není:
 * migrace patří do nasazení, ne do kliknutí v administraci.
 */

const TONE: Record<StatusLevel, { badge: string; label: string }> = {
  ok: { badge: "bg-emerald-50 text-emerald-700 ring-emerald-200", label: "V pořádku" },
  configured: { badge: "bg-blue-50 text-blue-700 ring-blue-200", label: "Nakonfigurováno" },
  missing: { badge: "bg-zinc-100 text-zinc-600 ring-zinc-200", label: "Nenakonfigurováno" },
  attention: { badge: "bg-amber-50 text-amber-800 ring-amber-300", label: "Vyžaduje pozornost" },
  unknown: { badge: "bg-zinc-100 text-zinc-500 ring-zinc-200", label: "Nelze ověřit" },
};

function Row({ item }: { item: SubsystemStatus }) {
  const tone = TONE[item.level];
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-900">{item.label}</h3>
        <span className={`badge ${tone.badge}`}>{tone.label}</span>
      </div>
      <p className="mt-1 text-sm text-zinc-700">{item.summary}</p>
      {item.action ? <p className="mt-1 text-sm text-amber-800">{item.action}</p> : null}
      {item.missingEnv && item.missingEnv.length > 0 ? (
        <p className="mt-1 break-words text-xs text-zinc-500">
          {/* Jen NÁZVY proměnných. Hodnoty sem nesmí ani omylem - tuhle
              stránku čte prohlížeč. */}
          Chybí proměnné:{" "}
          <span className="font-mono text-zinc-700">{item.missingEnv.join(", ")}</span>
        </p>
      ) : null}
      {item.details && item.details.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-xs text-zinc-500">
          {item.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default async function SystemStatusPage() {
  const status = await getSystemStatus();

  return (
    <>
      <PageHeader
        title="Stav systému"
        description="Co je nastavené, co chybí a co se z aplikace ověřit nedá."
      />
      <NastaveniTabs active="/stav" />

      <div className="max-w-2xl space-y-6">
        <div
          className={`card p-5 ${
            status.ready ? "border-emerald-200 bg-emerald-50/50" : "border-amber-300 bg-amber-50"
          }`}
        >
          <h2
            className={`text-sm font-semibold ${
              status.ready ? "text-emerald-900" : "text-amber-900"
            }`}
          >
            {status.ready ? "Systém je připravený" : "Databáze není připravená pro tuhle verzi"}
          </h2>
          <p className={`mt-1 text-sm ${status.ready ? "text-emerald-900" : "text-amber-900"}`}>
            {status.ready
              ? "Databáze i schéma odpovídají nasazené verzi. Jednotlivé funkce jsou níž."
              : "Dokud se schéma nedorovná, odesílání a volání jsou zastavené, aby nepracovaly " +
                "proti databázi, které nerozumí. Ostatní obrazovky fungují dál."}
          </p>
        </div>

        <ul className="card divide-y divide-zinc-100">
          {status.subsystems.map((item) => (
            <Row key={item.key} item={item} />
          ))}
        </ul>

        <p className="px-1 text-xs text-zinc-500">
          {/* Rozdíl, který se lehko smaže a pak z něj vznikne špatné
              rozhodnutí: „nakonfigurováno" není „funguje". */}
          <span className="font-medium text-zinc-600">Nakonfigurováno</span> znamená, že údaje
          existují — ne že jimi něco prošlo.{" "}
          <span className="font-medium text-zinc-600">V pořádku</span> znamená, že se to opravdu
          povedlo ověřit. Zjištěno <DateTime value={status.checkedAt} />.
        </p>
      </div>
    </>
  );
}
