// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * Regrese, kvůli které tenhle soubor vznikl.
 *
 * Tlačítko "Zavolat" bylo v produkci obyčejný odkaz `tel:`. Prohlížeč
 * ukázal ve stavovém řádku `tel:+420…`, předal to systémovému telefonu a
 * aplikace o hovoru nevěděla vůbec nic: nevznikl pokus, nešel zapsat
 * výsledek a nikdo se nedozvěděl, že telefonie na serveru není nastavená.
 *
 * Tady se hlídá to, co se tehdy rozjelo: že tlačítko je tlačítko, že
 * kliknutí opravdu jede přes Twilio, že se hovor zakládá na identifikátor
 * kontaktu (ne na telefonní číslo z prohlížeče), že chyba od Twilia se
 * ukáže člověku a že zavěšení posune stav.
 *
 * Twilio SDK je tu nahrazené - reálný hovor by test nesměl vytočit ani
 * omylem. Nahrazuje se ale jen SDK, ne naše logika: kontroluje se přesně
 * to, co bychom Twiliu poslali.
 */

// ------------------------------------------------------------- falešné SDK

type Handler = (payload?: unknown) => void;

class FakeEmitter {
  handlers = new Map<string, Handler[]>();
  on(event: string, handler: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  emit(event: string, payload?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

class FakeConnection extends FakeEmitter {
  muted = false;
  digits: string[] = [];
  disconnected = false;
  isMuted() { return this.muted; }
  mute(value: boolean) { this.muted = value; }
  sendDigits(digit: string) { this.digits.push(digit); }
  disconnect() {
    if (this.disconnected) return;
    this.disconnected = true;
    this.emit("disconnect");
  }
}

class FakeDevice extends FakeEmitter {
  static last: FakeDevice | null = null;
  static connectFails: unknown = null;
  connection: FakeConnection | null = null;
  connectParams: Record<string, string> | null = null;
  destroyed = false;
  constructor(public token: string, public options: unknown) {
    super();
    FakeDevice.last = this;
  }
  async connect(args: { params: Record<string, string> }) {
    this.connectParams = args.params;
    if (FakeDevice.connectFails) throw FakeDevice.connectFails;
    this.connection = new FakeConnection();
    return this.connection;
  }
  updateToken() {}
  disconnectAll() { this.connection?.disconnect(); }
  destroy() { this.destroyed = true; }
}

vi.mock("@twilio/voice-sdk", () => ({ Device: FakeDevice }));

// Post-call panel sahá na serverové akce; tady se testuje cockpit, ne
// formulář výsledku - ten má vlastní testy na serverové straně.
vi.mock("@/components/call/post-call-panel", () => ({
  PostCallPanel: () => React.createElement("div", { "data-testid": "post-call" }, "Zapsat výsledek"),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));

// ------------------------------------------------------------- prostředí

const CALL = {
  callId: "11111111-1111-1111-1111-111111111111",
  destination: "+420777123456",
  contactId: "22222222-2222-2222-2222-222222222222",
  contactName: "Ana Nováková",
  companyId: "33333333-3333-3333-3333-333333333333",
  companyName: "Acme",
  campaignContactId: "44444444-4444-4444-4444-444444444444",
};

let requests: { url: string; method: string; body: unknown }[] = [];
let tokenResponse: { status: number; body: unknown } = {
  status: 200,
  body: { configured: true, token: "fake.jwt.token", identity: "caller_1", expiresAt: Date.now() + 3600_000 },
};
let callsResponse: { status: number; body: unknown } = {
  status: 200,
  body: { call: CALL, briefing: null },
};
let micGranted = true;
let micAsked = 0;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  requests = [];
  micAsked = 0;
  micGranted = true;
  FakeDevice.last = null;
  FakeDevice.connectFails = null;
  tokenResponse = {
    status: 200,
    body: { configured: true, token: "fake.jwt.token", identity: "caller_1", expiresAt: Date.now() + 3600_000 },
  };
  callsResponse = { status: 200, body: { call: CALL, briefing: null } };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const chosen = url.startsWith("/api/calling/token") ? tokenResponse : callsResponse;
    return {
      ok: chosen.status >= 200 && chosen.status < 300,
      status: chosen.status,
      json: async () => chosen.body,
    } as Response;
  }) as typeof fetch;

  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        micAsked += 1;
        if (!micGranted) throw new DOMException("denied", "NotAllowedError");
        return { getTracks: () => [{ stop: () => {} }] };
      },
    },
  });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.resetModules();
});

async function mount(node: React.ReactElement) {
  await act(async () => {
    root.render(node);
  });
}

/** Klik na tlačítko Zavolat, včetně dojetí všech await uvnitř. */
async function clickCall() {
  const button = container.querySelector<HTMLButtonElement>("button[data-call-button='twilio']");
  if (!button) throw new Error("Tlačítko Zavolat na stránce není.");
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  // Řetěz token → /calls → connect je několik mikrotasků za sebou.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderApp(props: Partial<Parameters<typeof import("@/components/call/call-button").CallButton>[0]> = {}) {
  const { CallProvider } = await import("@/components/call/call-provider");
  const { CallButton } = await import("@/components/call/call-button");
  const { CallSurface } = await import("@/components/call/call-surface");
  await mount(
    React.createElement(
      CallProvider,
      null,
      React.createElement(
        CallButton,
        {
          phone: "+420 777 123 456",
          contactId: CALL.contactId,
          campaignContactId: CALL.campaignContactId,
          browserCalling: true,
          ...props,
        },
        "Zavolat",
      ),
      React.createElement(CallSurface, null),
    ),
  );
}

// ---------------------------------------------------------------- 1. tel:

describe("tlačítko Zavolat není odkaz tel:", () => {
  it("nikde ve zdrojích není href=\"tel:\"", () => {
    const root = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        const source = readFileSync(full, "utf8");
        // Komentáře o tom, že tel: odkaz nepoužíváme, jsou v pořádku;
        // hledá se skutečný atribut href.
        if (/href\s*=\s*[{"'`]\s*[`"']?tel:/.test(source)) {
          offenders.push(path.relative(process.cwd(), full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });

  it("vykreslí <button>, ne <a href=tel:> - ani když Twilio není nastavené", async () => {
    await renderApp({ browserCalling: false });
    expect(container.querySelector("a[href^='tel:']")).toBeNull();
    const button = container.querySelector("button[data-call-button='twilio']");
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("Zavolat");
  });

  it("obě varianty z detailu firmy (hlavička i řádek kontaktu) jsou tlačítko", async () => {
    const { CallProvider } = await import("@/components/call/call-provider");
    const { CallButton } = await import("@/components/call/call-button");
    await mount(
      React.createElement(
        CallProvider,
        null,
        // Hlavičkové CTA: bez vlastního popisku.
        React.createElement(CallButton, {
          key: "cta",
          phone: "+420 777 123 456",
          contactId: CALL.contactId,
          campaignContactId: CALL.campaignContactId,
          browserCalling: true,
        }),
        // Řádek kontaktu: vlastní popisek a menší tlačítko.
        React.createElement(
          CallButton,
          {
            key: "row",
            phone: "+420 777 123 456",
            contactId: CALL.contactId,
            campaignContactId: CALL.campaignContactId,
            browserCalling: true,
            className: "btn-go !py-1.5 text-sm",
          },
          "Zavolat",
        ),
      ),
    );
    const buttons = container.querySelectorAll("button[data-call-button='twilio']");
    expect(buttons).toHaveLength(2);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });
});

// -------------------------------------------------------------- 2. flow

describe("kliknutí spustí Twilio flow a otevře cockpit", () => {
  it("vyžádá token, založí hovor na serveru a předá Twiliu id hovoru", async () => {
    await renderApp();
    await clickCall();

    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /api/calling/token",
      "POST /api/calling/calls",
    ]);
    // Twilio dostane jen id hovoru, které vydal náš server.
    expect(FakeDevice.last?.connectParams).toEqual({ callId: CALL.callId });
    expect(FakeDevice.last?.token).toBe("fake.jwt.token");
  });

  it("otevře cockpit s kontaktem a stavem hovoru", async () => {
    await renderApp();
    await clickCall();
    expect(container.textContent).toContain("Ana Nováková");
    expect(container.textContent).toContain("Acme");
    expect(container.textContent).toContain("Vytáčím");

    await act(async () => FakeDevice.last?.connection?.emit("ringing"));
    expect(container.textContent).toContain("Vyzvání");

    await act(async () => FakeDevice.last?.connection?.emit("accept"));
    expect(container.textContent).toContain("Hovor");
    expect(container.textContent).toContain("Zavěsit");
  });
});

// ------------------------------------------------------------ 3. kontakt

describe("hovor se zakládá na správný kontakt", () => {
  it("posílá identifikátor kontaktu, nikdy telefonní číslo", async () => {
    await renderApp();
    await clickCall();
    const created = requests.find((r) => r.url === "/api/calling/calls");
    expect(created?.body).toEqual({ campaignContactId: CALL.campaignContactId });
    expect(JSON.stringify(created?.body)).not.toContain("777");
  });

  it("mimo kampaň posílá contactId", async () => {
    await renderApp({ campaignContactId: undefined });
    await clickCall();
    const created = requests.find((r) => r.url === "/api/calling/calls");
    expect(created?.body).toEqual({ contactId: CALL.contactId });
  });
});

// --------------------------------------------------------------- 4. chyby

describe("chyba se ukáže člověku", () => {
  it("chybu z Twilia přeloží do češtiny a nabídne zkusit znovu", async () => {
    FakeDevice.connectFails = { code: 31005, message: "ConnectionError (31005)" };
    await renderApp();
    await clickCall();
    expect(container.textContent).toContain("Spojení se nepodařilo navázat");
    expect(container.textContent).toContain("31005");
    expect(container.textContent).toContain("Zkusit znovu");
  });

  it("chybu ze serveru při zakládání hovoru ukáže tak, jak přišla", async () => {
    callsResponse = {
      status: 409,
      body: { error: "Nejdřív vyberte v Oslovení, kdo volá.", code: "no_caller" },
    };
    await renderApp();
    await clickCall();
    expect(container.textContent).toContain("Nejdřív vyberte v Oslovení, kdo volá.");
  });

  it("nenastavené Twilio vypíše chybějící proměnné a nežádá o mikrofon", async () => {
    tokenResponse = {
      status: 200,
      body: { configured: false, missing: ["TWILIO_API_KEY_SID", "TWILIO_TWIML_APP_SID"] },
    };
    await renderApp({ browserCalling: false });
    await clickCall();
    expect(container.textContent).toContain("TWILIO_API_KEY_SID");
    expect(container.textContent).toContain("TWILIO_TWIML_APP_SID");
    // Ptát se na mikrofon, když volat stejně nejde, je zbytečné obtěžování.
    expect(micAsked).toBe(0);
    // A hlavně: pořád žádný tel:.
    expect(container.querySelector("a[href^='tel:']")).toBeNull();
  });

  it("zakázaný mikrofon nespustí hovor na serveru", async () => {
    micGranted = false;
    await renderApp();
    await clickCall();
    expect(container.textContent).toContain("Mikrofon je zakázaný");
    expect(requests.some((r) => r.url === "/api/calling/calls")).toBe(false);
  });
});

// ------------------------------------------------------------- 5. ukončení

describe("ukončení hovoru aktualizuje stav", () => {
  it("zavěšení přepne na ukončeno a nabídne zápis výsledku", async () => {
    await renderApp();
    await clickCall();
    await act(async () => FakeDevice.last?.connection?.emit("accept"));

    const hangUp = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Zavěsit",
    );
    expect(hangUp).toBeDefined();
    await act(async () => {
      hangUp!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(FakeDevice.last?.connection?.disconnected).toBe(true);
    expect(container.textContent).toContain("Hovor ukončen");
    expect(container.querySelector("[data-testid='post-call']")).not.toBeNull();
  });

  it("zavěšení druhou stranou skončí stejně", async () => {
    await renderApp();
    await clickCall();
    await act(async () => FakeDevice.last?.connection?.emit("accept"));
    await act(async () => FakeDevice.last?.connection?.emit("disconnect"));
    expect(container.textContent).toContain("Hovor ukončen");
    expect(container.querySelector("[data-testid='post-call']")).not.toBeNull();
  });
});
