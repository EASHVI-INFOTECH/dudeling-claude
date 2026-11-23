/** WAV in and out (no models: the plugin's main thread and its engine threads both use it). */

/** Float32 samples → 16-bit PCM WAV. */
export function toWav(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** 16-bit PCM WAV → samples of the first channel. */
export function fromWav(wav: Buffer): { samples: Float32Array; rate: number } {
  if (wav.subarray(0, 4).toString() !== "RIFF" || wav.subarray(8, 12).toString() !== "WAVE") throw new Error("not a WAV file");
  let off = 12;
  let rate = 16000;
  let bits = 16;
  let channels = 1;
  while (off + 8 <= wav.length) {
    const id = wav.subarray(off, off + 4).toString();
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") {
      if (off + 24 > wav.length) throw new Error("WAV format is cut off");
      channels = wav.readUInt16LE(off + 10);
      rate = wav.readUInt32LE(off + 12);
      bits = wav.readUInt16LE(off + 22);
      if (!channels) throw new Error("WAV has no channels");
    } else if (id === "data") {
      if (bits !== 16) throw new Error("only 16-bit WAV");
      const n = Math.floor(Math.min(size, wav.length - off - 8) / 2 / channels);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = wav.readInt16LE(off + 8 + i * 2 * channels) / 32768;
      return { samples, rate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV has no audio");
}
