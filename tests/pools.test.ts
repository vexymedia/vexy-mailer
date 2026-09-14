import { describe, expect, it } from "vitest";
import { followUpBacklogWarning, planPools, poolTargets, type Pool } from "@/lib/engine/pools";

/**
 * Rozdělení denní kapacity.
 *
 * Dispatcher odesílá po jednom e-mailu, takže se tu simuluje celý den:
 * opakovaně se zeptáme, koho zkusit dál, a podle toho, kdo je zrovna
 * k dispozici, "odešleme". Tím se testuje přesně to, co poběží v provozu -
 * ne nějaký dávkový plánovač, který v aplikaci neexistuje.
 */

/**
 * Odsimuluje den. `newAvailable` / `followUpAvailable` jsou zásoby
 * kandidátů; pool bez kandidáta se přeskočí a přijde na řadu náhradník.
 */
function simulateDay(input: {
  dailyLimit: number;
  newRatio: number;
  newAvailable: number;
  followUpAvailable: number;
}): { sentNew: number; sentFollowUp: number; order: Pool[][] } {
  let sentNew = 0;
  let sentFollowUp = 0;
  let newLeft = input.newAvailable;
  let followLeft = input.followUpAvailable;
  const order: Pool[][] = [];

  // Horní hranice iterací: kdyby plán někdy nekončil, test spadne na
  // počtu, ne zacyklením.
  for (let i = 0; i < input.dailyLimit * 4 + 10; i++) {
    const plan = planPools({
      dailyLimit: input.dailyLimit,
      newRatio: input.newRatio,
      sentNew,
      sentFollowUp,
    });
    if (plan.capReached) break;
    order.push(plan.order);

    let sent = false;
    for (const pool of plan.order) {
      if (pool === "new" && newLeft > 0) {
        newLeft--;
        sentNew++;
        sent = true;
        break;
      }
      if (pool === "follow_up" && followLeft > 0) {
        followLeft--;
        sentFollowUp++;
        sent = true;
        break;
      }
    }
    if (!sent) break; // nikdo není k dispozici
  }

  return { sentNew, sentFollowUp, order };
}

describe("cílové rozdělení", () => {
  it("70 % z limitu 100 je 70 nových a 30 follow-upů", () => {
    expect(poolTargets(100, 70)).toEqual({ new: 70, follow_up: 30 });
  });

  it("součet je vždy přesně limit - nejdou nastavit dvě nezávislá procenta", () => {
    for (const ratio of [0, 13, 33, 50, 66, 70, 99, 100]) {
      for (const limit of [1, 7, 100, 137]) {
        const t = poolTargets(limit, ratio);
        expect(t.new + t.follow_up).toBe(limit);
        expect(t.new).toBeGreaterThanOrEqual(0);
        expect(t.follow_up).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("nesmyslné hodnoty se ořežou, ne zhavarují", () => {
    expect(poolTargets(-5, 70)).toEqual({ new: 0, follow_up: 0 });
    expect(poolTargets(100, 250)).toEqual({ new: 100, follow_up: 0 });
    expect(poolTargets(100, -20)).toEqual({ new: 0, follow_up: 100 });
  });
});

describe("hlavní scénář: 600 kontaktů, limit 100, 70/30", () => {
  it("při dostatku obou front vyjde poměr 70/30 a celkem přesně 100", () => {
    const day = simulateDay({ dailyLimit: 100, newRatio: 70, newAvailable: 600, followUpAvailable: 200 });
    expect(day.sentNew + day.sentFollowUp).toBe(100);
    expect(day.sentNew).toBe(70);
    expect(day.sentFollowUp).toBe(30);
  });

  it("600 kontaktů a limit 100 nikdy neodešle víc než 100", () => {
    const day = simulateDay({ dailyLimit: 100, newRatio: 100, newAvailable: 600, followUpAvailable: 0 });
    expect(day.sentNew + day.sentFollowUp).toBe(100);
  });

  it("tvrdý strop platí i při obrovské zásobě v obou frontách", () => {
    const day = simulateDay({ dailyLimit: 100, newRatio: 70, newAvailable: 5000, followUpAvailable: 5000 });
    expect(day.sentNew + day.sentFollowUp).toBe(100);
  });
});

describe("přelití nevyužité kapacity", () => {
  it("jen 10 due follow-upů: odejde 10 follow-upů a 90 nových", () => {
    const day = simulateDay({ dailyLimit: 100, newRatio: 70, newAvailable: 600, followUpAvailable: 10 });
    expect(day.sentFollowUp).toBe(10);
    expect(day.sentNew).toBe(90);
    expect(day.sentNew + day.sentFollowUp).toBe(100);
  });

  it("jen 20 nových: odejde 20 nových a 80 follow-upů", () => {
    const day = simulateDay({ dailyLimit: 100, newRatio: 70, newAvailable: 20, followUpAvailable: 300 });
    expect(day.sentNew).toBe(20);
    expect(day.sentFollowUp).toBe(80);
    expect(day.sentNew + day.sentFollowUp).toBe(100);
  });

  it("přelití nikdy nepřekročí strop", () => {
    for (const [n, f] of [[5, 500], [500, 5], [0, 500], [500, 0], [50, 50]]) {
      const day = simulateDay({ dailyLimit: 100, newRatio: 70, newAvailable: n, followUpAvailable: f });
      expect(day.sentNew + day.sentFollowUp).toBeLessThanOrEqual(100);
    }
  });
});

describe("follow-up backlog nesmí sebrat rezervovaný new pool", () => {
  it("300 čekajících follow-upů neubere nových pod jejich cíl", () => {
    const day = simulateDay({ dailyLimit: 100, newRatio: 70, newAvailable: 600, followUpAvailable: 300 });
    expect(day.sentNew).toBe(70);
    expect(day.sentFollowUp).toBe(30);
  });

  it("45 due follow-upů při cíli 30: pošle se 30, zbytek zůstane frontě", () => {
    const day = simulateDay({ dailyLimit: 100, newRatio: 70, newAvailable: 600, followUpAvailable: 45 });
    expect(day.sentFollowUp).toBe(30);
    // 15 se nikam neztratilo - jen se dnes nedostalo na řadu.
    expect(45 - day.sentFollowUp).toBe(15);
  });

  it("nové kontakty se nikdy nezastaví úplně, ať je backlog jakkoli velký", () => {
    const day = simulateDay({ dailyLimit: 100, newRatio: 70, newAvailable: 100, followUpAvailable: 100_000 });
    expect(day.sentNew).toBeGreaterThanOrEqual(70);
  });
});

describe("pořadí poolů", () => {
  it("první tick dne začíná u toho, kdo má větší podíl", () => {
    expect(planPools({ dailyLimit: 100, newRatio: 70, sentNew: 0, sentFollowUp: 0 }).order[0]).toBe("new");
    expect(planPools({ dailyLimit: 100, newRatio: 30, sentNew: 0, sentFollowUp: 0 }).order[0]).toBe("follow_up");
  });

  it("pool na svém cíli zůstává v pořadí jako náhradník", () => {
    const plan = planPools({ dailyLimit: 100, newRatio: 70, sentNew: 70, sentFollowUp: 0 });
    expect(plan.order).toEqual(["follow_up", "new"]);
  });

  it("vyčerpaný strop nevrátí žádný pool", () => {
    const plan = planPools({ dailyLimit: 100, newRatio: 70, sentNew: 70, sentFollowUp: 30 });
    expect(plan.capReached).toBe(true);
    expect(plan.order).toEqual([]);
    expect(plan.remainingTotal).toBe(0);
  });

  it("poměr 100/0 nedá follow-upům žádný cíl, ale nechá je jako náhradníka", () => {
    const plan = planPools({ dailyLimit: 100, newRatio: 100, sentNew: 0, sentFollowUp: 0 });
    expect(plan.targets).toEqual({ new: 100, follow_up: 0 });
    expect(plan.order).toContain("follow_up");
  });
});

describe("upozornění na rostoucí backlog", () => {
  it("mlčí, dokud je backlog zvládnutelný", () => {
    expect(followUpBacklogWarning({ dueFollowUps: 30, followUpTarget: 30 })).toBeNull();
    expect(followUpBacklogWarning({ dueFollowUps: 60, followUpTarget: 30 })).toBeNull();
    expect(followUpBacklogWarning({ dueFollowUps: 0, followUpTarget: 30 })).toBeNull();
  });

  it("ozve se, až když se backlog nedá rozpustit za dva dny", () => {
    const warning = followUpBacklogWarning({ dueFollowUps: 150, followUpTarget: 30 });
    expect(warning).toContain("150");
    expect(warning).toContain("5 dní");
  });

  it("poměr sám nezvyšuje - jen upozorní", () => {
    const before = planPools({ dailyLimit: 100, newRatio: 70, sentNew: 0, sentFollowUp: 0 });
    followUpBacklogWarning({ dueFollowUps: 500, followUpTarget: 30 });
    const after = planPools({ dailyLimit: 100, newRatio: 70, sentNew: 0, sentFollowUp: 0 });
    expect(after.targets).toEqual(before.targets);
  });

  it("follow-upy bez vyhrazené kapacity se ohlásí zvlášť", () => {
    expect(followUpBacklogWarning({ dueFollowUps: 5, followUpTarget: 0 }))
      .toContain("vyhrazenou žádnou kapacitu");
  });
});
