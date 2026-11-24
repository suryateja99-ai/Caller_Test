// Browser Web Audio utilities for Gemini 3.8 Live API
// Input: 16kHz PCM16 LE mono | Output: 24kHz PCM16 LE mono with gapless scheduling

export function float32ToPcm16Base64(float32Data: Float32Array): string {
  const int16 = new Int16Array(float32Data.length);
  for (let i = 0; i < float32Data.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Data[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function computeRmsLevel(float32Data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < float32Data.length; i++) {
    sum += float32Data[i] * float32Data[i];
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, float32Data.length)) * 3.5);
}

export class GaplessPcmPlayer {
  private ctx: AudioContext | null = null;
  private nextStartTime = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private readonly sampleRate = 24000;

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext({ sampleRate: this.sampleRate });
      this.nextStartTime = this.ctx.currentTime;
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public enqueuePcm24kBase64(base64Data: string): void {
    const ctx = this.ensureContext();
    const binary = atob(base64Data);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const view = new DataView(bytes.buffer);
    const numSamples = Math.floor(bytes.byteLength / 2);
    if (numSamples === 0) return;

    const audioBuffer = ctx.createBuffer(1, numSamples, this.sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < numSamples; i++) {
      channelData[i] = view.getInt16(i * 2, true) / 32768;
    }

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    // Only add jitter cushion on initial start or genuine underrun — never shift playhead while audio is still playing
    if (this.nextStartTime < now) {
      this.nextStartTime = now + 0.05;
    }

    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };
  }

  public interrupt(): void {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // already stopped
      }
    }
    this.activeSources.clear();
    if (this.ctx && this.ctx.state !== 'closed') {
      this.nextStartTime = this.ctx.currentTime;
    }
  }

  public dispose(): void {
    this.interrupt();
    if (this.ctx && this.ctx.state !== 'closed') {
      void this.ctx.close();
    }
    this.ctx = null;
  }
}
