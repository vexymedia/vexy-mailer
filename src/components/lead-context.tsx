import Link from "next/link";
import type { LeadContextView } from "@/lib/lead-context-view";

/**
 * Kontext leadu nad tlačítkem Zavolat.
 *
 * Server ho posílá hotový - časy i texty vznikají jednou, v pražské zóně.
 * Sekce, která nemá obsah, se nevykreslí vůbec: prázdný rámeček s nadpisem
 * „Co už jsme poslali“ je horší než nic, protože caller ztratí vteřinu
 * čtením a nic se nedozví.
 */

function Section({
  title,
  children,
  tone = "plain",
}: {
  title: string;
  children: React.ReactNode;
  tone?: "plain" | "accent";
}) {
  return (
    <div
      className={`rounded-md border px-4 py-3 ${
        tone === "accent" ? "border-emerald-200 bg-emerald-50/60" : "border-zinc-200 bg-zinc-50"
      }`}
    >
      <h3 className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/** Proč voláme právě teď, jako řetěz skutečných událostí. */
export function WhyNow({ steps }: { steps: string[] }) {
  if (steps.length === 0) return null;
  return (
    <Section title="Proč volám právě teď">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-900">
        {steps.map((step, index) => (
          <li key={step} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden className="text-zinc-400">→</span> : null}
            <span className={index === steps.length - 1 ? "font-medium" : ""}>{step}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/** Co prospekt už dostal. Bez Loomu se sekce nezobrazuje. */
export function LoomCard({ loom }: { loom: LeadContextView["loom"] }) {
  if (!loom) return null;
  return (
    <Section title="Co už jsme poslali">
      <p className="text-sm font-medium text-zinc-900">{loom.title ?? "Video pro prospekta"}</p>
      {loom.sentAt ? <p className="text-xs text-zinc-500">odesláno {loom.sentAt}</p> : null}
      {loom.note ? (
        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">
          {loom.note}
        </p>
      ) : null}
      <a
        href={loom.url}
        target="_blank"
        rel="noreferrer noopener"
        className="btn-secondary mt-2 !py-1 text-xs"
      >
        Otevřít video
      </a>
    </Section>
  );
}

function Quote({
  label,
  message,
}: {
  label: string;
  message: NonNullable<LeadContextView["lastOutbound"]>;
}) {
  return (
    <div>
      <p className="text-xs text-zinc-500">
        {label} · <span className="tabular-nums">{message.when}</span>
      </p>
      {message.subject ? (
        <p className="text-sm font-medium text-zinc-900">{message.subject}</p>
      ) : null}
      {message.snippet ? (
        <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-zinc-700">
          {message.snippet}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Poslední e-mailová výměna.
 *
 * Do cockpitu patří jen ukázka - celá konverzace se otevře ve Schránce.
 * Caller nesmí mít důvod přepnout do Gmailu, ale taky sem nepatří celý
 * mailový klient.
 */
export function EmailContext({
  lastOutbound,
  lastInbound,
}: {
  lastOutbound: LeadContextView["lastOutbound"];
  lastInbound: LeadContextView["lastInbound"];
}) {
  if (!lastOutbound && !lastInbound) return null;
  const href = lastInbound?.href ?? lastOutbound?.href ?? null;
  return (
    <Section title="Poslední e-mail">
      <div className="space-y-3">
        {lastOutbound ? <Quote label="My" message={lastOutbound} /> : null}
        {lastInbound ? <Quote label="Prospekt" message={lastInbound} /> : null}
      </div>
      {href ? (
        <Link href={href} className="btn-secondary mt-2 !py-1 text-xs">
          Zobrazit celou konverzaci
        </Link>
      ) : null}
    </Section>
  );
}

/** Jak začít. Dvě až čtyři věty, ne celý scénář. */
export function Opener({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Section title="Jak začít" tone="accent">
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-900">{text}</p>
    </Section>
  );
}

/** Všechny sekce v pořadí, ve kterém je caller čte. */
export type { LeadContextView };

export function LeadContextPanels({ view }: { view: LeadContextView }) {
  return (
    <div className="space-y-3">
      <WhyNow steps={view.whyNow} />
      <LoomCard loom={view.loom} />
      <EmailContext lastOutbound={view.lastOutbound} lastInbound={view.lastInbound} />
      <Opener text={view.opener} />
    </div>
  );
}
