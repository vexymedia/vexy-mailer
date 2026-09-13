import { describe, expect, it } from "vitest";
import { buildMonoWav, parseWav, splitWavChannels, wavChannelCount } from "@/lib/telephony/wav";

/**
 * Rozdělení kanálů je základ rozlišení řečníků, takže se testuje na
 * skutečných bajtech - ne na tom, co si o formátu myslíme.
 */

/** Stereo WAV, kde levý kanál má vzorky 1,2,3… a pravý 101,102,103… */
function stereoWav(frames: number, bitsPerSample = 16, audioFormat = 1): Buffer {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = bytesPerSample * 2;
  const data = Buffer.alloc(frames * blockAlign);
  for (let i = 0; i < frames; i++) {
    if (bitsPerSample === 16) {
      data.writeInt16LE(i + 1, i * blockAlign);
      data.writeInt16LE(i + 101, i * blockAlign + 2);
    } else {
      data.writeUInt8(i + 1, i * blockAlign);
      data.writeUInt8(i + 101, i * blockAlign + 1);
    }
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000 * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("čtení WAV hlavičky", () => {
  it("přečte formát tak, jak je v souboru", () => {
    const parsed = parseWav(stereoWav(10));
    expect(parsed?.format).toEqual({
      audioFormat: 1,
      channels: 2,
      sampleRate: 8000,
      bitsPerSample: 16,
      blockAlign: 4,
    });
    expect(parsed?.data).toHaveLength(40);
  });

  it("pozná počet kanálů, aniž by soubor rozděloval", () => {
    expect(wavChannelCount(stereoWav(5))).toBe(2);
    expect(wavChannelCount(buildMonoWav(
      { audioFormat: 1, channels: 1, sampleRate: 8000, bitsPerSample: 16, blockAlign: 2 },
      Buffer.alloc(10),
    ))).toBe(1);
  });

  it("odmítne, co není WAV", () => {
    expect(parseWav(Buffer.from("tohle je mp3, ne wav, a je dost dlouhé na hlavičku..."))).toBeNull();
    expect(parseWav(Buffer.alloc(10))).toBeNull();
    expect(wavChannelCount(Buffer.from("nesmysl"))).toBeNull();
  });
});

describe("rozdělení kanálů", () => {
  it("rozdělí stereo na dvě mono stopy a nezamíchá vzorky", () => {
    const channels = splitWavChannels(stereoWav(4));
    expect(channels).toHaveLength(2);

    const left = parseWav(channels![0])!;
    const right = parseWav(channels![1])!;
    expect(left.format.channels).toBe(1);
    expect(right.format.channels).toBe(1);
    // Kanál 0 je volající (obchodník), kanál 1 volaný (prospekt).
    expect([0, 1, 2, 3].map((i) => left.data.readInt16LE(i * 2))).toEqual([1, 2, 3, 4]);
    expect([0, 1, 2, 3].map((i) => right.data.readInt16LE(i * 2))).toEqual([101, 102, 103, 104]);
  });

  it("zachová vzorkovací frekvenci a bitovou hloubku", () => {
    const [left] = splitWavChannels(stereoWav(8))!;
    const parsed = parseWav(left)!;
    expect(parsed.format.sampleRate).toBe(8000);
    expect(parsed.format.bitsPerSample).toBe(16);
    // Hlavička musí sedět, jinak by to přepisovač odmítl.
    expect(parsed.data.length).toBe(8 * 2);
    expect(left.readUInt32LE(4)).toBe(36 + 8 * 2);
  });

  it("zvládne i osmibitový μ-law, jak ho Twilio umí poslat", () => {
    const channels = splitWavChannels(stereoWav(4, 8, 7));
    expect(channels).toHaveLength(2);
    const left = parseWav(channels![0])!;
    expect(left.format.audioFormat).toBe(7);
    expect([0, 1, 2, 3].map((i) => left.data.readUInt8(i))).toEqual([1, 2, 3, 4]);
  });

  it("mono nerozděluje - vrátí null a volající přepíše nahrávku vcelku", () => {
    const mono = buildMonoWav(
      { audioFormat: 1, channels: 1, sampleRate: 8000, bitsPerSample: 16, blockAlign: 2 },
      Buffer.alloc(20),
    );
    expect(splitWavChannels(mono)).toBeNull();
  });

  it("nespadne na prázdném ani poškozeném souboru", () => {
    expect(splitWavChannels(Buffer.alloc(0))).toBeNull();
    expect(splitWavChannels(stereoWav(0))).toBeNull();
    expect(splitWavChannels(Buffer.from("RIFF....WAVEnesmysl"))).toBeNull();
  });
});
