"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Call, Device } from "@twilio/voice-sdk";
import { callErrorCode, callErrorMessage } from "@/lib/telephony/call-state";

/**
 * Stav hovoru na úrovni aplikace.
 *
 * Provider je namontovaný v layoutu, ne na stránce. To je celý smysl:
 * caller si během hovoru otevře detail firmy nebo přejde na další záznam
 * a hovor to nesmí položit. Kdyby stav vlastnila stránka, zabil by ho
 * první router.push.
 *
 * Twilio SDK se načítá až při prvním hovoru (dynamický import). Nemá co
 * dělat v úvodním bundlu a hlavně nemá smysl se ptát na mikrofon někomu,
 * kdo dnes volat nebude.
 */

export type CallUiState =
  | "idle"
  | "permission"
  | "connecting"
  | "ringing"
  | "active"
  | "ending"
  | "ended"
  | "failed";

export const CALL_UI_LABELS: Record<CallUiState, string> = {
  idle: "Připraveno",
  permission: "Čekám na mikrofon",
  connecting: "Vytáčím",
  ringing: "Vyzvání",
  active: "Hovor",
  ending: "Ukončuji",
  ended: "Hovor ukončen",
  failed: "Nepodařilo se",
};

export interface CallTarget {
  callId: string;
  destination: string;
  contactId: string;
  contactName: string;
  companyId: string | null;
  companyName: string | null;
  campaignContactId: string | null;
}

export interface CallBriefing {
  position: string | null;
  email: string | null;
  reason: string | null;
  priorityLabel: string | null;
  statusLabel: string | null;
  campaignName: string | null;
  attempt: number;
  maxAttempts: number | null;
  qualification: string | null;
  script: { title: string; text: string }[];
  recent: { id: string; when: string; text: string }[];
  nextStep: string | null;
}

export interface ActiveCall {
  target: CallTarget;
  briefing: CallBriefing | null;
  /** Kdy se hovor spojil. Null dokud se nezvedne - timer běží až od spojení. */
  answeredAt: number | null;
  /** Poslední známá délka, aby ji šlo ukázat i po zavěšení. */
  durationSeconds: number | null;
}

interface CallContextValue {
  state: CallUiState;
  call: ActiveCall | null;
  error: string | null;
  /** Kód od providera. Do UI se dává jen jako drobná stopa pro podporu. */
  errorCode: number | null;
  muted: boolean;
  /** Nastavené Twilio? Null = ještě se nezjišťovalo. */
  configured: boolean | null;
  missingEnv: string[];
  cockpitOpen: boolean;
  start(input: { contactId?: string; campaignContactId?: string }): Promise<void>;
  hangUp(): void;
  toggleMute(): void;
  sendDigit(digit: string): void;
  openCockpit(): void;
  closeCockpit(): void;
  /** Zkusí znovu poslední hovor. Nic nedělá, když žádný nebyl. */
  retry(): void;
  /** Zavře cockpit a zahodí dokončený hovor - "jdu na další kontakt". */
  dismiss(): void;
}

const CallStateContext = createContext<CallContextValue | null>(null);

export function useCalling(): CallContextValue {
  const value = useContext(CallStateContext);
  if (!value) throw new Error("useCalling musí být uvnitř <CallProvider>");
  return value;
}

async function requestMicrophone(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, error: "Tenhle prohlížeč neumí volání. Zkuste Chrome, Edge nebo Safari." };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stopa se hned pouští: povolení zůstane, ale nesvítí zbytečně indikátor.
    stream.getTracks().forEach((track) => track.stop());
    return { ok: true };
  } catch (error) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      return {
        ok: false,
        error: "Mikrofon je zakázaný. Povolte ho v adresním řádku prohlížeče a zkuste to znovu.",
      };
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return { ok: false, error: "Nenašel jsem žádný mikrofon. Připojte headset a zkuste to znovu." };
    }
    return { ok: false, error: "K mikrofonu se nepodařilo dostat." };
  }
}

export function CallProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CallUiState>("idle");
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  // Poslední cíl, aby šlo po neúspěchu zkusit znovu bez hledání kontaktu.
  const lastTarget = useRef<{ contactId?: string; campaignContactId?: string } | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [missingEnv, setMissingEnv] = useState<string[]>([]);
  const [cockpitOpen, setCockpitOpen] = useState(false);

  const deviceRef = useRef<Device | null>(null);
  const connectionRef = useRef<Call | null>(null);

  // Zařízení se uklidí, i když uživatel zavře záložku uprostřed hovoru.
  useEffect(() => {
    return () => {
      connectionRef.current?.disconnect();
      deviceRef.current?.destroy();
      deviceRef.current = null;
    };
  }, []);

  const ensureDevice = useCallback(async (): Promise<Device | null> => {
    if (deviceRef.current) return deviceRef.current;

    const response = await fetch("/api/calling/token", { cache: "no-store" });
    if (!response.ok) {
      setError("Nepodařilo se získat přístup k telefonii. Zkuste se znovu přihlásit.");
      return null;
    }
    const data = (await response.json()) as
      | { configured: false; missing: string[] }
      | { configured: true; token: string };
    if (!data.configured) {
      setConfigured(false);
      setMissingEnv(data.missing);
      setError("Volání z prohlížeče není nastavené.");
      return null;
    }
    setConfigured(true);
    setMissingEnv([]);

    // Až tady: SDK je velké a v úvodním bundlu nemá co dělat.
    const { Device } = await import("@twilio/voice-sdk");
    const device = new Device(data.token, {
      // Opus zní na hovoru lépe než PCMU a Twilio si ho s telefonní sítí
      // přeloží samo.
      codecPreferences: ["opus", "pcmu"] as never,
      logLevel: "error" as never,
    });
    device.on("error", (deviceError: unknown) => {
      setError(callErrorMessage(deviceError));
      setErrorCode(callErrorCode(deviceError));
      setState((current) => (current === "idle" ? "idle" : "failed"));
    });
    // Token platí hodinu; SDK si o nový řekne včas.
    device.on("tokenWillExpire", async () => {
      try {
        const refreshed = await fetch("/api/calling/token", { cache: "no-store" });
        const body = (await refreshed.json()) as { configured: boolean; token?: string };
        if (body.configured && body.token) device.updateToken(body.token);
      } catch {
        // Nevadí: pokud se obnova nepovede, další hovor si vyžádá nové zařízení.
      }
    });
    deviceRef.current = device;
    return device;
  }, []);

  const start = useCallback(
    async (input: { contactId?: string; campaignContactId?: string }) => {
      if (state === "connecting" || state === "ringing" || state === "active") return;
      lastTarget.current = input;
      setError(null);
      setErrorCode(null);
      setMuted(false);
      setState("permission");

      const microphone = await requestMicrophone();
      if (!microphone.ok) {
        setError(microphone.error);
        setState("failed");
        setCockpitOpen(true);
        return;
      }

      setState("connecting");
      const device = await ensureDevice();
      if (!device) {
        setState("failed");
        setCockpitOpen(true);
        return;
      }

      // Server si číslo dohledá sám; klient posílá jen identifikátor.
      const created = await fetch("/api/calling/calls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const payload = (await created.json()) as
        | ({ call: CallTarget; briefing: CallBriefing | null })
        | { error: string };
      if (!created.ok || !("call" in payload)) {
        setError("error" in payload ? payload.error : "Hovor se nepodařilo založit.");
        setState("failed");
        setCockpitOpen(true);
        return;
      }

      setCall({ target: payload.call, briefing: payload.briefing, answeredAt: null, durationSeconds: null });
      setCockpitOpen(true);

      try {
        const connection = await device.connect({ params: { callId: payload.call.callId } });
        connectionRef.current = connection;

        connection.on("ringing", () => setState("ringing"));
        connection.on("accept", () => {
          setState("active");
          setCall((current) => (current ? { ...current, answeredAt: Date.now() } : current));
        });
        connection.on("disconnect", () => {
          connectionRef.current = null;
          setState("ended");
          setCall((current) =>
            current
              ? {
                  ...current,
                  durationSeconds: current.answeredAt
                    ? Math.round((Date.now() - current.answeredAt) / 1000)
                    : 0,
                }
              : current,
          );
        });
        connection.on("cancel", () => {
          connectionRef.current = null;
          setState("ended");
        });
        connection.on("reject", () => {
          connectionRef.current = null;
          setState("ended");
        });
        connection.on("error", (callError: unknown) => {
          connectionRef.current = null;
          setError(callErrorMessage(callError));
          setErrorCode(callErrorCode(callError));
          setState("failed");
        });
      } catch (connectError) {
        setError(callErrorMessage(connectError));
        setErrorCode(callErrorCode(connectError));
        setState("failed");
      }
    },
    [ensureDevice, state],
  );

  const hangUp = useCallback(() => {
    setState((current) => (current === "active" || current === "ringing" || current === "connecting" ? "ending" : current));
    connectionRef.current?.disconnect();
    deviceRef.current?.disconnectAll();
  }, []);

  const toggleMute = useCallback(() => {
    const connection = connectionRef.current;
    if (!connection) return;
    const next = !connection.isMuted();
    connection.mute(next);
    setMuted(next);
  }, []);

  const sendDigit = useCallback((digit: string) => {
    connectionRef.current?.sendDigits(digit);
  }, []);

  const retry = useCallback(() => {
    const target = lastTarget.current;
    if (!target) return;
    setCall(null);
    setState("idle");
    setError(null);
    setErrorCode(null);
    void start(target);
  }, [start]);

  const dismiss = useCallback(() => {
    connectionRef.current?.disconnect();
    connectionRef.current = null;
    setCall(null);
    setState("idle");
    setError(null);
    setCockpitOpen(false);
  }, []);

  const value = useMemo<CallContextValue>(
    () => ({
      state,
      call,
      error,
      errorCode,
      muted,
      configured,
      missingEnv,
      cockpitOpen,
      start,
      hangUp,
      toggleMute,
      sendDigit,
      openCockpit: () => setCockpitOpen(true),
      closeCockpit: () => setCockpitOpen(false),
      retry,
      dismiss,
    }),
    [state, call, error, errorCode, muted, configured, missingEnv, cockpitOpen, start, hangUp, toggleMute, sendDigit, retry, dismiss],
  );

  return <CallStateContext.Provider value={value}>{children}</CallStateContext.Provider>;
}

/**
 * Běžící čas hovoru.
 *
 * Vlastní komponenta se svým intervalem schválně: kdyby vteřiny držel
 * provider, překresloval by se každou sekundu celý strom aplikace pod ním.
 */
export function CallTimer({ since, fallback = "00:00" }: { since: number | null; fallback?: string }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (since === null) {
      setSeconds(0);
      return;
    }
    const update = () => setSeconds(Math.max(0, Math.round((Date.now() - since) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [since]);

  if (since === null) return <span className="tabular-nums">{fallback}</span>;
  const minutes = Math.floor(seconds / 60);
  return (
    <span className="tabular-nums">
      {String(minutes).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}
    </span>
  );
}
