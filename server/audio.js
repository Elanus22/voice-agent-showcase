// PCM-Hilfen für die Telefon-Bridge (server/phone.js).
// Alles 16-bit signed, mono, little-endian.
//
// Sample-Raten im Spiel:
//   AudioSocket (Asterisk/Telefon) : 8 kHz  (slin)
//   Gemini Live Eingang            : 16 kHz
//   Gemini Live Ausgang            : 24 kHz
//
// Hochtasten (8 → 16 kHz) darf linear interpolieren. Beim Heruntertasten
// (24 → 8 kHz) muss vorher gefiltert werden: siehe createTelefonTiefpass().

/** Buffer (LE int16) → Int16Array. */
export function bufToInt16(buf) {
  const out = new Int16Array(buf.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Int16Array → Buffer (LE int16). */
export function int16ToBuf(samples) {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

/** Koeffizienten eines Biquad-Tiefpasses (RBJ Audio EQ Cookbook). */
function biquadTiefpass(f0, rate, q) {
  const w = (2 * Math.PI * f0) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const b1 = 1 - cos;
  const a0 = 1 + alpha;
  return {
    b0: b1 / 2 / a0,
    b1: b1 / a0,
    b2: b1 / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * Tiefpass auf 3,4 kHz — den oberen Rand des Telefonbands. Vor jede
 * Dezimation auf 8 kHz schalten, sonst faltet sich alles über 4 kHz
 * (Zischlaute, „S", „F", „Sch") ins Nutzband zurück und die Stimme klingt
 * blechern.
 *
 * Zwei kaskadierte Biquads (4. Ordnung, Butterworth-Güten). Eine Stufe allein
 * dämpft bei 8 kHz nur ~15 dB — das landet gefaltet mitten in der Sprache.
 *
 * Der Filter hat **Zustand** und gehört deshalb pro Audiostrom EINMAL
 * angelegt, nicht pro Chunk: Setzt man ihn an jeder Chunk-Grenze zurück,
 * knackt es an genau diesen Grenzen.
 */
export function createTelefonTiefpass(rate) {
  const stufen = [0.5412, 1.3066].map((q) => ({
    k: biquadTiefpass(3400, rate, q),
    x1: 0, x2: 0, y1: 0, y2: 0,
  }));

  return (input) => {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let s = input[i];
      for (const st of stufen) {
        const y =
          st.k.b0 * s + st.k.b1 * st.x1 + st.k.b2 * st.x2 - st.k.a1 * st.y1 - st.k.a2 * st.y2;
        st.x2 = st.x1;
        st.x1 = s;
        st.y2 = st.y1;
        st.y1 = y;
        s = y;
      }
      // Butterworth schwingt an Flanken leicht über — ohne Deckel liefe der
      // int16 über und aus dem Überschwinger würde ein Knacken.
      out[i] = Math.max(-32768, Math.min(32767, Math.round(s)));
    }
    return out;
  };
}

/**
 * Lineares Resampling. Chunk-weise aufgerufen; winzige Sprünge an
 * Chunk-Grenzen sind bei Sprache nicht hörbar.
 */
export function resampleLinear(input, inRate, outRate) {
  if (inRate === outRate || input.length === 0) return input;
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.floor(input.length * ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const idx = Math.floor(src);
    const frac = src - idx;
    const s0 = input[idx] ?? 0;
    const s1 = idx + 1 < input.length ? input[idx + 1] : s0;
    out[i] = Math.round(s0 + (s1 - s0) * frac);
  }
  return out;
}
