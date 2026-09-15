/**
 * Rozdělení denní kapacity mezi nové kontakty a follow-upy.
 *
 * Celá aritmetika je tady, bez databáze a bez Reactu, aby se dala
 * otestovat na stole: na tomhle stojí, že se za den neodešle víc, než
 * kolik je nastaveno, a že backlog follow-upů nezastaví akvizici.
 *
 * Tři pravidla, v tomhle pořadí:
 *
 *   1. TVRDÝ STROP. Součet přes oba pooly nikdy nepřekročí denní limit
 *      kampaně. Všechno ostatní je až za tím.
 *   2. CÍLOVÉ ROZDĚLENÍ, ne oddíl. 70/30 říká, kolik slotů si pool
 *      rezervuje, dokud o ně stojí. Když jich tolik nepotřebuje,
 *      zbytek propadá druhému - viz pravidlo 3.
 *   3. PŘELITÍ. Pool bez kandidátů svou kapacitu nedrží. Když je due
 *      jen 10 follow-upů a limit je 100 při poměru 70/30, odejde 10
 *      follow-upů a 90 nových, ne 10 a 70.
 *
 * Co se tu SCHVÁLNĚ nedělá: poměr se sám nezvyšuje, když backlog roste.
 * To je rozhodnutí o kampani, ne o jednom ticku - aplikace na rostoucí
 * backlog jen upozorní.
 */

export type Pool = "new" | "follow_up";

export interface PoolTargets {
  /** Kolik z denního limitu si drží nové kontakty. */
  new: number;
  /** Zbytek. Dopočítaný, nikdy nezávisle nastavený. */
  follow_up: number;
}

/**
 * Cílové rozdělení limitu. `newRatio` je procento pro nové kontakty;
 * follow-upy dostanou zbytek, takže součet je vždy přesně limit a
 * nemůže vzniknout konfigurace 70 + 40.
 */
export function poolTargets(dailyLimit: number, newRatio: number): PoolTargets {
  const limit = Math.max(0, Math.trunc(dailyLimit));
  const ratio = Math.min(100, Math.max(0, Math.trunc(newRatio)));
  const forNew = Math.round((limit * ratio) / 100);
  return { new: forNew, follow_up: limit - forNew };
}

export interface PoolState {
  dailyLimit: number;
  newRatio: number;
  /** Kolik nových odešlo dnes. */
  sentNew: number;
  /** Kolik follow-upů odešlo dnes. */
  sentFollowUp: number;
}

export interface PoolPlan {
  targets: PoolTargets;
  sentTotal: number;
  /** Kolik ještě dnes smí odejít celkem. Tvrdý strop. */
  remainingTotal: number;
  /** Pořadí, ve kterém se dnes zkouší poolům brát práci. */
  order: Pool[];
  /** Vyčerpaný strop. Když je true, `order` je prázdné. */
  capReached: boolean;
}

/**
 * Pořadí poolů pro JEDEN send.
 *
 * Dispatcher odesílá po jednom, takže tahle funkce neřeší dávku - řeší
 * jen "koho zkusit teď a koho jako náhradníka". Když první pool nemá
 * kandidáta, zkusí se druhý; tím vzniká přelití v obou směrech, aniž by
 * bylo potřeba dopředu vědět, kolik kandidátů vlastně existuje.
 *
 * Pořadí uvnitř "obou" se rozhoduje podle NAPLNĚNOSTI vůči cíli, ne
 * podle absolutních čísel. Při 70/30 a stavu 7 nových / 3 follow-upů je
 * oba pooly naplněné z 10 % a na řadě je ten, který je pozadu - takže
 * poměr drží sám od sebe, bez plánovače dávek.
 */
export function planPools(state: PoolState): PoolPlan {
  const targets = poolTargets(state.dailyLimit, state.newRatio);
  const sentTotal = state.sentNew + state.sentFollowUp;
  const remainingTotal = Math.max(0, state.dailyLimit - sentTotal);

  if (remainingTotal === 0) {
    return { targets, sentTotal, remainingTotal, order: [], capReached: true };
  }

  const newHasRoom = state.sentNew < targets.new;
  const followHasRoom = state.sentFollowUp < targets.follow_up;

  // Naplněnost vůči vlastnímu cíli. Pool s nulovým cílem je "plný"
  // okamžitě - smysl má jen jako náhradník.
  const fill = (sent: number, target: number) => (target <= 0 ? Number.POSITIVE_INFINITY : sent / target);
  const newFill = fill(state.sentNew, targets.new);
  const followFill = fill(state.sentFollowUp, targets.follow_up);
  // Při shodě (typicky první send dne, 0/0) rozhoduje velikost cíle.
  // Bez toho by poměr 30/70 začal dnem u nových, což je přesně naopak.
  const newFirst =
    newFill === followFill ? targets.new >= targets.follow_up : newFill < followFill;

  let order: Pool[];
  if (newHasRoom && followHasRoom) {
    order = newFirst ? ["new", "follow_up"] : ["follow_up", "new"];
  } else if (newHasRoom) {
    // Follow-upy jsou na svém cíli. Zůstávají jako náhradník: zbylé
    // sloty smí využít, ale až když se nenajde nový kontakt.
    order = ["new", "follow_up"];
  } else if (followHasRoom) {
    order = ["follow_up", "new"];
  } else {
    // Oba na cíli, ale strop ještě ne - stane se při zaokrouhlení nebo
    // když jeden pool předtím přelil do druhého. Pořadí podle poměru.
    order = newFirst ? ["new", "follow_up"] : ["follow_up", "new"];
  }

  return { targets, sentTotal, remainingTotal, order, capReached: false };
}

/**
 * Roste backlog follow-upů natolik, že to stojí za zmínku?
 *
 * Záměrně jen upozornění, ne automatika. Zvednout podíl follow-upů
 * znamená oslovit míň nových firem - to je obchodní rozhodnutí a
 * aplikace ho za člověka dělat nebude.
 *
 * Práh: backlog, který se při dnešní follow-up kapacitě nedá rozpustit
 * za dva pracovní dny. Pod tím je "zítra to dožene" a hlásit to je šum.
 */
export function followUpBacklogWarning(input: {
  dueFollowUps: number;
  followUpTarget: number;
}): string | null {
  const { dueFollowUps, followUpTarget } = input;
  if (dueFollowUps === 0) return null;
  if (followUpTarget <= 0) {
    return "Follow-upy čekají, ale kampaň pro ně nemá vyhrazenou žádnou kapacitu.";
  }
  if (dueFollowUps <= followUpTarget * 2) return null;
  const days = Math.ceil(dueFollowUps / followUpTarget);
  return `Follow-up backlog roste: ${dueFollowUps} čeká, denně jich odejde ~${followUpTarget} (${days} dní). Zvažte zvýšení podílu follow-upů.`;
}
