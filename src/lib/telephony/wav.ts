/**
 * Rozdělení dvoukanálové WAV nahrávky na dvě jednokanálové.
 *
 * Tohle je celý základ rozlišení řečníků. Twilio nahrává hovor jako
 * `record-from-answer-dual`, což znamená, že každá větev hovoru má vlastní
 * kanál: kanál 0 je ten, kdo volal (obchodník v prohlížeči), kanál 1 je
 * volaný (prospekt). Když se každý kanál přepíše zvlášť, víme jistě, kdo
 * co řekl - není to odhad modelu, je to fyzicky oddělený zvuk.
 *
 * Proto se stahuje WAV, ne MP3: MP3 z Twilia je smíchaný do mona a tím se
 * informace o tom, kdo mluví, nenávratně ztratí.
 *
 * Formát se čte z hlavičky, nespoléhá se na domněnky o tom, co Twilio
 * pošle. Když přijde mono, pozná se to a přepíše se postaru.
 */

export interface WavFormat {
  /** 1 = PCM, 7 = μ-law. Jiné hodnoty nerozdělujeme. */
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Bajtů na jeden vzorek všech kanálů dohromady. */
  blockAlign: number;
}

export interface ParsedWav {
  format: WavFormat;
  /** Syrová data vzorků, bez hlavičky. */
  data: Buffer;
}

function readChunks(buffer: Buffer): { id: string; start: number; size: number }[] {
  const chunks: { id: string; start: number; size: number }[] = [];
  let offset = 12; // za "RIFF" + velikost + "WAVE"
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const declared = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    // Deklarovaná velikost může lhát (streamovaný zápis); nikdy nečteme
    // za konec bufferu.
    const size = Math.min(declared, Math.max(0, buffer.length - start));
    chunks.push({ id, start, size });
    // Chunky jsou zarovnané na sudý počet bajtů.
    offset = start + size + (size % 2);
    if (declared === 0 && id !== "data") break;
  }
  return chunks;
}

export function parseWav(buffer: Buffer): ParsedWav | null {
  if (buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  const chunks = readChunks(buffer);
  const fmt = chunks.find((chunk) => chunk.id === "fmt ");
  const data = chunks.find((chunk) => chunk.id === "data");
  if (!fmt || !data || fmt.size < 16) return null;

  const format: WavFormat = {
    audioFormat: buffer.readUInt16LE(fmt.start),
    channels: buffer.readUInt16LE(fmt.start + 2),
    sampleRate: buffer.readUInt32LE(fmt.start + 4),
    blockAlign: buffer.readUInt16LE(fmt.start + 12),
    bitsPerSample: buffer.readUInt16LE(fmt.start + 14),
  };
  if (format.channels < 1 || format.sampleRate <= 0 || format.bitsPerSample <= 0) return null;

  return { format, data: buffer.subarray(data.start, data.start + data.size) };
}

/** Složí jednokanálový WAV ze syrových vzorků. */
export function buildMonoWav(format: WavFormat, samples: Buffer): Buffer {
  const bytesPerSample = Math.ceil(format.bitsPerSample / 8);
  const byteRate = format.sampleRate * bytesPerSample;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format.audioFormat, 20);
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(bytesPerSample, 32);
  header.writeUInt16LE(format.bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.length, 40);

  return Buffer.concat([header, samples]);
}

/**
 * Rozdělí stereo nahrávku na pole jednokanálových WAVů.
 *
 * Vrací null, když se rozdělit nedá - mono nahrávka, neznámý formát nebo
 * poškozený soubor. Volající pak přepíše nahrávku vcelku, jen bez
 * rozlišení řečníků. Nikdy se nehádá.
 */
export function splitWavChannels(buffer: Buffer): Buffer[] | null {
  const parsed = parseWav(buffer);
  if (!parsed) return null;

  const { format, data } = parsed;
  if (format.channels < 2) return null;

  const bytesPerSample = Math.ceil(format.bitsPerSample / 8);
  const frame = format.blockAlign > 0 ? format.blockAlign : bytesPerSample * format.channels;
  if (frame !== bytesPerSample * format.channels) return null;

  const frames = Math.floor(data.length / frame);
  if (frames === 0) return null;

  const channels = Array.from({ length: format.channels }, () =>
    Buffer.alloc(frames * bytesPerSample),
  );

  for (let index = 0; index < frames; index++) {
    const base = index * frame;
    for (let channel = 0; channel < format.channels; channel++) {
      data.copy(
        channels[channel],
        index * bytesPerSample,
        base + channel * bytesPerSample,
        base + (channel + 1) * bytesPerSample,
      );
    }
  }

  return channels.map((samples) => buildMonoWav(format, samples));
}

/** Kolik kanálů nahrávka má, aniž bychom ji rozdělovali. */
export function wavChannelCount(buffer: Buffer): number | null {
  return parseWav(buffer)?.format.channels ?? null;
}
