// Pure TypeScript G.711 mu-law <-> Linear PCM16 audio transcoder
// Bridges Twilio Media Streams (8kHz mu-law) and Gemini Live API (16kHz input / 24kHz output PCM16)

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

// Precomputed 256-entry G.711 mu-law decode table to 16-bit signed linear PCM
const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const mu = ~i & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  MULAW_DECODE_TABLE[i] = sign !== 0 ? -sample : sample;
}

function encodeMuLawSample(sample: number): number {
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }
  if (sample > MULAW_CLIP) {
    sample = MULAW_CLIP;
  }
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    // find highest set bit
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/**
 * Converts base64 8kHz G.711 mu-law (Twilio Media Streams) to base64 16kHz PCM16 LE (Gemini Live input)
 */
export function mulaw8kBase64ToPcm16kBase64(mulawBase64: string): string {
  const mulawBuf = Buffer.from(mulawBase64, 'base64');
  const inLen = mulawBuf.length;
  if (inLen === 0) return '';

  // Upsample 8kHz -> 16kHz (2x) with linear interpolation
  const outSamples = new Int16Array(inLen * 2);
  let prev = MULAW_DECODE_TABLE[mulawBuf[0]];

  for (let i = 0; i < inLen; i++) {
    const curr = MULAW_DECODE_TABLE[mulawBuf[i]];
    const next = i + 1 < inLen ? MULAW_DECODE_TABLE[mulawBuf[i + 1]] : curr;
    outSamples[i * 2] = curr;
    outSamples[i * 2 + 1] = (curr + next) >> 1;
    prev = curr;
  }
  void prev;

  return Buffer.from(outSamples.buffer, outSamples.byteOffset, outSamples.byteLength).toString('base64');
}

/**
 * Converts base64 24kHz PCM16 LE (Gemini Live output) to base64 8kHz G.711 mu-law (Twilio Media Streams)
 */
export function pcm24kBase64ToMulaw8kBase64(pcm24kBase64: string): string {
  const pcmBuf = Buffer.from(pcm24kBase64, 'base64');
  const totalSamples = Math.floor(pcmBuf.length / 2);
  const outLen = Math.floor(totalSamples / 3);
  if (outLen === 0) return '';

  const mulawOut = Buffer.allocUnsafe(outLen);
  for (let i = 0; i < outLen; i++) {
    const idx = i * 3;
    const s0 = pcmBuf.readInt16LE(idx * 2);
    const s1 = pcmBuf.readInt16LE((idx + 1) * 2);
    const s2 = pcmBuf.readInt16LE((idx + 2) * 2);
    // 3-tap boxcar anti-aliasing average for 24kHz -> 8kHz
    const avg = Math.round((s0 + s1 + s2) / 3);
    mulawOut[i] = encodeMuLawSample(avg);
  }

  return mulawOut.toString('base64');
}
