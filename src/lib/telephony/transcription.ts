import type { CallAnalysis } from "./call-state";
import { parseAnalysis } from "./call-state";

/**
 * Přepis a analýza hovoru, oddělené od providera.
 *
 * Twilio umí přepis samo, ale draze a hůř česky. Architektura je proto
 * nahrávka -> náš backend -> speech-to-text -> analýza, a obojí jde
 * vyměnit: rozhraní je pár funkcí, ne konkrétní API.
 */

export interface TranscriptionResult {
  text: string;
  language: string | null;
  provider: string;
  /**
   * Časové úseky řeči. Používají se k proložení dvou samostatně
   * přepsaných kanálů do jedné konverzace ve správném pořadí.
   */
  segments: { text: string; start: number | null; end: number | null }[];
}

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: Buffer, options: { contentType: string; languageHint?: string | null }): Promise<
    { ok: true; result: TranscriptionResult } | { ok: false; error: string }
  >;
}

export interface AnalysisProvider {
  readonly name: string;
  analyse(input: AnalysisInput): Promise<
    { ok: true; analysis: CallAnalysis } | { ok: false; error: string }
  >;
}

export interface AnalysisInput {
  transcript: string;
  companyName: string | null;
  contactName: string | null;
  /** Proč firmu řešíme - bez toho model neví, co byl cíl hovoru. */
  reason: string | null;
  /** Povolené hodnoty outcome, aby návrh šel rovnou předvybrat. */
  allowedOutcomes: { value: string; label: string }[];
}

// ------------------------------------------------------------------ OpenAI

function openAiKey(): string | null {
  return process.env.OPENAI_API_KEY?.trim() || null;
}

export function isTranscriptionConfigured(): boolean {
  return openAiKey() !== null;
}

const OPENAI_BASE = () => process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";

/**
 * Přepis přes OpenAI. Čeština a slovenština jsou v modelu podporované,
 * jazyk se schválně nevnucuje - u dvojjazyčného hovoru je automatická
 * detekce lepší než špatný tip.
 */
export const openAiTranscription: TranscriptionProvider = {
  name: "openai",
  async transcribe(audio, options) {
    const key = openAiKey();
    if (!key) return { ok: false, error: "OPENAI_API_KEY není nastavený." };

    const model = process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "whisper-1";
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: options.contentType }), "call.mp3");
    form.append("model", model);
    form.append("response_format", "verbose_json");
    if (options.languageHint) form.append("language", options.languageHint);

    try {
      const response = await fetch(`${OPENAI_BASE()}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
      });
      if (!response.ok) {
        const body = await response.text();
        return { ok: false, error: `Přepis selhal (${response.status}): ${body.slice(0, 200)}` };
      }
      const data = (await response.json()) as {
        text?: string;
        language?: string;
        segments?: { text?: string; start?: number; end?: number }[];
      };
      const text = (data.text ?? "").trim();
      if (!text) return { ok: false, error: "Přepis je prázdný." };

      const segments = (data.segments ?? [])
        .map((segment) => ({
          text: (segment.text ?? "").trim(),
          start: typeof segment.start === "number" ? segment.start : null,
          end: typeof segment.end === "number" ? segment.end : null,
        }))
        .filter((segment) => segment.text.length > 0);

      return {
        ok: true,
        result: {
          text,
          language: data.language ?? null,
          provider: "openai",
          // Bez časů se dvojice kanálů proložit nedá; zbyde jeden úsek
          // a konverzace se poskládá alespoň po kanálech.
          segments: segments.length > 0 ? segments : [{ text, start: null, end: null }],
        },
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};

const ANALYSIS_SYSTEM_PROMPT = [
  "Jsi asistent obchodníka, který dělá B2B cold outbound.",
  "Dostaneš přepis telefonátu a vrátíš strukturovaná data pro CRM.",
  "Přepis může být rozdělený podle řečníků: 'Obchodník:' je náš člověk,",
  "'Prospekt:' je volaná firma. Bolesti, námitky a signály zájmu hledej",
  "VÝHRADNĚ v tom, co řekl prospekt - co řekl obchodník je nabídka, ne",
  "potřeba zákazníka. Nikdy nepřičítej větu obchodníka prospektovi.",
  "Piš česky. Nic si nevymýšlej: co v hovoru nezaznělo, nech prázdné nebo null.",
  "Nepřidávej žádný text mimo JSON.",
].join(" ");

function analysisUserPrompt(input: AnalysisInput): string {
  const outcomes = input.allowedOutcomes.map((o) => `${o.value} (${o.label})`).join(", ");
  return [
    input.companyName ? `Firma: ${input.companyName}` : null,
    input.contactName ? `Kontakt: ${input.contactName}` : null,
    input.reason ? `Proč firmu řešíme: ${input.reason}` : null,
    "",
    "Přepis hovoru:",
    input.transcript.slice(0, 24_000),
    "",
    `Pole "outcome" musí být přesně jedna z těchto hodnot: ${outcomes}.`,
    `Pole "followUpAt" je datum ve formátu YYYY-MM-DD, jen pokud padlo konkrétní datum.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** JSON schema, které si vynutíme na modelu, aby výstup šel parsovat. */
const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary", "outcome", "sentiment", "pains", "needs", "objections", "buyingSignals",
    "competitorsMentioned", "timing", "budgetMentioned", "authoritySignal", "nextStep",
    "followUpAt", "recommendedFollowUp", "importantQuotes",
  ],
  properties: {
    summary: { type: ["string", "null"] },
    outcome: { type: ["string", "null"] },
    sentiment: { type: ["string", "null"], enum: ["positive", "neutral", "negative", null] },
    pains: { type: "array", items: { type: "string" } },
    needs: { type: "array", items: { type: "string" } },
    objections: { type: "array", items: { type: "string" } },
    buyingSignals: { type: "array", items: { type: "string" } },
    competitorsMentioned: { type: "array", items: { type: "string" } },
    timing: { type: ["string", "null"] },
    budgetMentioned: { type: ["boolean", "null"] },
    authoritySignal: { type: ["string", "null"] },
    nextStep: { type: ["string", "null"] },
    followUpAt: { type: ["string", "null"] },
    recommendedFollowUp: { type: ["string", "null"] },
    importantQuotes: { type: "array", items: { type: "string" } },
  },
} as const;

export const openAiAnalysis: AnalysisProvider = {
  name: "openai",
  async analyse(input) {
    const key = openAiKey();
    if (!key) return { ok: false, error: "OPENAI_API_KEY není nastavený." };

    const model = process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-4o-mini";
    try {
      const response = await fetch(`${OPENAI_BASE()}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
            { role: "user", content: analysisUserPrompt(input) },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "call_analysis", strict: true, schema: ANALYSIS_SCHEMA },
          },
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        return { ok: false, error: `Analýza selhala (${response.status}): ${body.slice(0, 200)}` };
      }
      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) return { ok: false, error: "Model nevrátil žádný obsah." };
      return { ok: true, analysis: parseAnalysis(JSON.parse(content)) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
};
