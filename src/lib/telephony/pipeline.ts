import { sql } from "../db";
import { CALL_OUTCOMES } from "../calling";
import { fetchRecording, isTwilioConfigured, twilioConfig } from "./twilio";
import {
  mergeAdjacentSegments,
  renderTranscript,
  suggestedOutcomeFrom,
  type SpeakerRole,
  type TranscriptSegment,
} from "./call-state";
import { splitWavChannels } from "./wav";
import {
  openAiAnalysis,
  openAiTranscription,
  isTranscriptionConfigured,
  type AnalysisProvider,
  type TranscriptionProvider,
} from "./transcription";
import {
  failAnalysis,
  failTranscript,
  listPipelineWork,
  markAnalysisProcessing,
  reapAbandonedCalls,
  markTranscriptProcessing,
  resetStalePipeline,
  saveAnalysis,
  saveTranscript,
  type CallRow,
} from "../queries/calls";

/**
 * Nahrávka -> přepis -> analýza, na pozadí.
 *
 * Žádná nová infrastruktura: jede to na stejném ticku jako odesílání
 * e-mailů, protože ten už v projektu je, běží každou minutu a je
 * idempotentní. Fronta v Redisu by tady byla čistě spekulativní.
 *
 * Každý krok je samostatný a smí selhat sám za sebe. Když se nepodaří
 * přepis, zůstane nahrávka i metadata hovoru - a jde to zkusit znovu.
 */

export interface PipelineResult {
  picked: number;
  transcribed: number;
  analysed: number;
  failed: number;
  skipped: string | null;
  /** Došel čas a zbytek se dodělá v dalším ticku. */
  deferred: number;
}

const EMPTY: PipelineResult = {
  picked: 0,
  transcribed: 0,
  analysed: 0,
  failed: 0,
  skipped: null,
  deferred: 0,
};

/**
 * Kolik času si nechat na analýzu, než se do ní vůbec pustíme. Je lepší
 * ji odložit o tick, než ji rozjet a nechat funkci spadnout na limitu
 * uprostřed - to by hovor zaseklo na "zpracovává se" až do reaperu.
 */
const ANALYSIS_BUDGET_MS = 15_000;

async function callContext(call: CallRow): Promise<{
  companyName: string | null;
  contactName: string | null;
  reason: string | null;
}> {
  const [row] = await sql<
    { company_name: string | null; reason: string | null; first_name: string | null; last_name: string | null; email: string }[]
  >`
    select co.name as company_name, co.reason, c.first_name, c.last_name, c.email
      from contacts c left join companies co on co.id = c.company_id
     where c.id = ${call.contact_id}
  `;
  if (!row) return { companyName: null, contactName: null, reason: null };
  return {
    companyName: row.company_name,
    contactName: [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || row.email,
    reason: row.reason,
  };
}

export async function processCallPipeline(
  options: {
    limit?: number;
    transcription?: TranscriptionProvider;
    analysis?: AnalysisProvider;
    /**
     * Čas (epoch ms), do kdy se musí stihnout skončit. Tick běží ve
     * funkci s limitem, takže se pracuje na rozpočet, ne dokud je co dělat.
     */
    deadline?: number;
  } = {},
): Promise<PipelineResult> {
  const transcription = options.transcription ?? openAiTranscription;
  const analysis = options.analysis ?? openAiAnalysis;
  const deadline = options.deadline ?? Date.now() + 45_000;

  // Bez klíčů se nemá cenu ani dívat do fronty - hovory tam počkají,
  // dokud se klíče nedoplní, a nic se neztratí.
  const usingDefaults = !options.transcription && !options.analysis;
  if (usingDefaults && !isTranscriptionConfigured()) {
    // Uklidit opuštěné hovory se musí i bez klíčů - jinak by v historii
    // navždy visely jako "vytáčím".
    await reapAbandonedCalls();
    return { ...EMPTY, skipped: "OPENAI_API_KEY není nastavený." };
  }
  if (usingDefaults && !isTwilioConfigured()) {
    await reapAbandonedCalls();
    return { ...EMPTY, skipped: "Twilio není nakonfigurované." };
  }

  await resetStalePipeline();
  await reapAbandonedCalls();

  const work = await listPipelineWork(options.limit ?? 3);
  const result: PipelineResult = { ...EMPTY, picked: work.length };

  /**
   * Vrací text přepisu, když se povedl.
   *
   * Když je nahrávka dvoukanálová, přepíše se každý kanál zvlášť a
   * výsledky se proloží podle času. Kanál 0 je vždycky obchodník (větev
   * z prohlížeče), kanál 1 prospekt - rozlišení řečníků tedy není odhad,
   * ale fyzicky oddělený zvuk. Mono nahrávka (starší hovor, vypnuté
   * dvoukanálové nahrávání) se přepíše postaru, bez rolí.
   */
  const runTranscript = async (call: CallRow): Promise<string | null> => {
    if (!(await markTranscriptProcessing(call.id))) return null;
    try {
      const config = twilioConfig();
      const audio = await fetchRecording(config, call.recording_url ?? "");
      if (!audio.ok) {
        await failTranscript(call.id, audio.error);
        result.failed++;
        return null;
      }

      const channels = splitWavChannels(audio.audio);
      const roles: SpeakerRole[] = ["agent", "prospect"];
      let language: string | null = null;
      let provider = transcription.name;
      let segments: TranscriptSegment[] = [];
      let monoText: string | null = null;

      if (channels && channels.length >= 2) {
        // Dva průchody přepisovačem, jeden na každou stranu hovoru.
        for (const [index, role] of roles.entries()) {
          const transcribed = await transcription.transcribe(channels[index], {
            contentType: "audio/wav",
          });
          if (!transcribed.ok) {
            await failTranscript(call.id, transcribed.error);
            result.failed++;
            return null;
          }
          language ??= transcribed.result.language;
          provider = transcribed.result.provider;
          for (const segment of transcribed.result.segments) {
            segments.push({ speaker: role, text: segment.text, start: segment.start, end: segment.end });
          }
        }
        // Do jedné konverzace podle času. Segmenty bez času skončí na
        // konci, ale pořád u správného řečníka.
        segments.sort((a, b) => (a.start ?? Number.MAX_SAFE_INTEGER) - (b.start ?? Number.MAX_SAFE_INTEGER));
        segments = mergeAdjacentSegments(segments);
      } else {
        const transcribed = await transcription.transcribe(audio.audio, {
          contentType: audio.contentType,
        });
        if (!transcribed.ok) {
          await failTranscript(call.id, transcribed.error);
          result.failed++;
          return null;
        }
        language = transcribed.result.language;
        provider = transcribed.result.provider;
        monoText = transcribed.result.text;
      }

      // Plochý text zůstává zdrojem pravdy pro starý kód i pro fulltext;
      // u dvoukanálového hovoru už nese role.
      const transcript = segments.length > 0 ? renderTranscript(segments) : monoText;
      if (!transcript) {
        await failTranscript(call.id, "Přepis je prázdný.");
        result.failed++;
        return null;
      }

      await saveTranscript({
        callId: call.id,
        transcript,
        segments,
        channels: channels?.length ?? null,
        language,
        provider,
      });
      result.transcribed++;
      return transcript;
    } catch (error) {
      await failTranscript(call.id, error instanceof Error ? error.message : String(error));
      result.failed++;
      return null;
    }
  };

  const runAnalysis = async (call: CallRow, transcript: string): Promise<void> => {
    if (!(await markAnalysisProcessing(call.id))) return;
    try {
      const context = await callContext(call);
      const analysed = await analysis.analyse({
        transcript,
        companyName: context.companyName,
        contactName: context.contactName,
        reason: context.reason,
        allowedOutcomes: CALL_OUTCOMES.map((o) => ({ value: o.value, label: o.label })),
      });
      if (!analysed.ok) {
        await failAnalysis(call.id, analysed.error);
        result.failed++;
        return;
      }
      await saveAnalysis({
        callId: call.id,
        analysis: analysed.analysis,
        provider: analysis.name,
        suggestedOutcome: suggestedOutcomeFrom(analysed.analysis),
      });
      result.analysed++;
    } catch (error) {
      await failAnalysis(call.id, error instanceof Error ? error.message : String(error));
      result.failed++;
    }
  };

  for (const call of work) {
    if (Date.now() >= deadline) {
      result.deferred++;
      continue;
    }

    // ---- přepis -------------------------------------------------------
    if (call.recording_status === "available" && call.transcript_status === "pending") {
      const transcript = await runTranscript(call);
      if (!transcript) continue;
      // Analýza rovnou navazuje, pokud na ni zbývá čas. Čekat na další
      // tick by callerovi přidalo minutu, ve které nemá co číst.
      if (Date.now() + ANALYSIS_BUDGET_MS <= deadline) {
        await runAnalysis(call, transcript);
      } else {
        result.deferred++;
      }
      continue;
    }

    // ---- analýza ------------------------------------------------------
    if (call.transcript_status === "done" && call.analysis_status === "pending") {
      if (Date.now() + ANALYSIS_BUDGET_MS > deadline) {
        result.deferred++;
        continue;
      }
      await runAnalysis(call, call.transcript ?? "");
    }
  }

  return result;
}
