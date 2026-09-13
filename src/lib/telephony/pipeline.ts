import { sql } from "../db";
import { CALL_OUTCOMES } from "../calling";
import { fetchRecording, isTwilioConfigured, twilioConfig } from "./twilio";
import { suggestedOutcomeFrom } from "./call-state";
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
}

const EMPTY: PipelineResult = { picked: 0, transcribed: 0, analysed: 0, failed: 0, skipped: null };

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
  } = {},
): Promise<PipelineResult> {
  const transcription = options.transcription ?? openAiTranscription;
  const analysis = options.analysis ?? openAiAnalysis;

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
    return { ...EMPTY, skipped: "Twilio není nakonfigurované." };
  }

  await resetStalePipeline();
  await reapAbandonedCalls();

  const work = await listPipelineWork(options.limit ?? 3);
  const result: PipelineResult = { ...EMPTY, picked: work.length };

  for (const call of work) {
    // ---- přepis -------------------------------------------------------
    if (call.recording_status === "available" && call.transcript_status === "pending") {
      if (!(await markTranscriptProcessing(call.id))) continue;
      try {
        const config = twilioConfig();
        const audio = await fetchRecording(config, call.recording_url ?? "");
        if (!audio.ok) {
          await failTranscript(call.id, audio.error);
          result.failed++;
          continue;
        }
        const transcribed = await transcription.transcribe(audio.audio, {
          contentType: audio.contentType,
        });
        if (!transcribed.ok) {
          await failTranscript(call.id, transcribed.error);
          result.failed++;
          continue;
        }
        await saveTranscript({
          callId: call.id,
          transcript: transcribed.result.text,
          language: transcribed.result.language,
          provider: transcribed.result.provider,
        });
        result.transcribed++;
      } catch (error) {
        await failTranscript(call.id, error instanceof Error ? error.message : String(error));
        result.failed++;
      }
      // Analýza se udělá v dalším ticku: dlouhý přepis i analýza v jednom
      // běhu by se u serverless funkce mohly nevejít do limitu.
      continue;
    }

    // ---- analýza ------------------------------------------------------
    if (call.transcript_status === "done" && call.analysis_status === "pending") {
      if (!(await markAnalysisProcessing(call.id))) continue;
      try {
        const context = await callContext(call);
        const analysed = await analysis.analyse({
          transcript: call.transcript ?? "",
          companyName: context.companyName,
          contactName: context.contactName,
          reason: context.reason,
          allowedOutcomes: CALL_OUTCOMES.map((o) => ({ value: o.value, label: o.label })),
        });
        if (!analysed.ok) {
          await failAnalysis(call.id, analysed.error);
          result.failed++;
          continue;
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
    }
  }

  return result;
}
