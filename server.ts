import 'dotenv/config';
import crypto from 'crypto';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { type Request, type Response } from 'express';
import twilio from 'twilio';
import { WebSocketServer, WebSocket } from 'ws';
import {
  ActivityHandling,
  EndSensitivity,
  Modality,
  StartSensitivity,
  type LiveServerMessage,
} from '@google/genai';
import type {
  CallRecord,
  CallStatus,
  Lead,
  LeadStage,
  ServiceFocus,
  ServerConfigStatus,
  VoiceOptionId,
} from './src/types.ts';
import { mulaw8kBase64ToPcm16kBase64, pcm24kBase64ToMulaw8kBase64 } from './src/server/audioCodec.ts';
import {
  buildTenglishSystemInstruction,
  escapeXml,
  getAgentPersonaName,
  isValidE164Phone,
  maskPhoneNumber,
} from './src/server/persona.ts';
import {
  formatGeminiError,
  generateCallSummary,
  generateInlinePhonePitch,
  generateTenglishPlaybook,
  getGeminiClient,
  synthesizeTenglishSpeech,
} from './src/server/gemini.ts';
import { store } from './src/server/store.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const ALLOWED_SERVICES: ServiceFocus[] = ['web_app', 'mobile_app', 'meta_ads'];
const ALLOWED_VOICES: VoiceOptionId[] = ['Leda', 'Aoede', 'Zephyr', 'Kore'];
const ALLOWED_LEAD_STAGES: LeadStage[] = ['New', 'Contacted', 'Interested', 'Follow-up', 'Not Interested'];

function getTwilioCredentials(): { accountSid: string; authToken: string; phoneNumber: string } | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || '';
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() || '';
  const phoneNumber = process.env.TWILIO_PHONE_NUMBER?.trim() || '';
  if (!accountSid || !authToken || !phoneNumber) {
    return null;
  }
  return { accountSid, authToken, phoneNumber };
}

function resolvePublicBaseUrl(req?: Request): string {
  const customWebhook = process.env.WEBHOOK_BASE_URL?.trim();
  if (customWebhook && /^https:\/\//i.test(customWebhook)) {
    return customWebhook.replace(/\/+$/, '');
  }
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && /^https?:\/\//i.test(envUrl) && !envUrl.includes('MY_APP_URL')) {
    return envUrl.replace(/\/+$/, '');
  }
  if (req) {
    const forwardedHost = req.header('x-forwarded-host')?.split(',')[0]?.trim();
    const host = forwardedHost || req.header('host')?.trim();
    const proto = req.header('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
    if (host) {
      return `${proto}://${host}`.replace(/\/+$/, '');
    }
  }
  return '';
}

function isPublicHttpsUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Cache webhook reachability check for 30s so Twilio calls in private AI Studio
// dev preview automatically use inline TwiML instead of failing with a 302 auth redirect.
let webhookProbeCache: { url: string; reachable: boolean; checkedAt: number } | null = null;

async function probeWebhookReachable(baseUrl: string): Promise<boolean> {
  if (!isPublicHttpsUrl(baseUrl)) return false;
  if (
    webhookProbeCache &&
    webhookProbeCache.url === baseUrl &&
    Date.now() - webhookProbeCache.checkedAt < 30_000
  ) {
    return webhookProbeCache.reachable;
  }
  try {
    const resp = await fetch(`${baseUrl}/api/twilio/health`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(3500),
    });
    const reachable = resp.status === 200;
    webhookProbeCache = { url: baseUrl, reachable, checkedAt: Date.now() };
    return reachable;
  } catch {
    webhookProbeCache = { url: baseUrl, reachable: false, checkedAt: Date.now() };
    return false;
  }
}

function sanitizeTwilioSayText(raw: string): string {
  return raw
    // Remove control chars, zero-width joiners/non-joiners, and emojis/symbols that can trigger Twilio 13520
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\uFEFF]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\.{2,}/g, '.')
    .replace(/[\u2014\u2013]/g, ', ')
    .replace(/[*_`#<>[\](){}"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitIntoChirpSafeSentences(segments: string[], maxSentenceBytes = 240): string[] {
  const sentencesOut: string[] = [];

  for (const rawSeg of segments) {
    const cleaned = sanitizeTwilioSayText(rawSeg);
    if (!cleaned) continue;

    const sentences = cleaned
      .split(/(?<=[.!?।])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const sentence of sentences) {
      if (Buffer.byteLength(sentence, 'utf8') <= maxSentenceBytes) {
        sentencesOut.push(/[.!?]$/.test(sentence) ? sentence : `${sentence}.`);
        continue;
      }

      const words = sentence.split(/\s+/);
      let current = '';
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (Buffer.byteLength(candidate, 'utf8') <= maxSentenceBytes) {
          current = candidate;
        } else {
          if (current) {
            sentencesOut.push(/[.!?]$/.test(current) ? current : `${current}.`);
          }
          current = word;
        }
      }
      if (current) {
        sentencesOut.push(/[.!?]$/.test(current) ? current : `${current}.`);
      }
    }
  }

  if (sentencesOut.length === 0) {
    return ['హలో అండీ, నేను అనన్యని, వెబ్‌డెవ్స్ నుంచి మాట్లాడుతున్నా.'];
  }

  return sentencesOut;
}

function packSentencesIntoFluidSayBlocks(sentences: string[], maxSayBytes = 950): string[] {
  // Pack short properly-punctuated sentences into ONE single <Say> block (up to 950 UTF-8 bytes)
  // so Twilio doesn't introduce awkward 700ms fetch gaps between every sentence, while keeping
  // every individual sentence short (<=240 bytes) so Google Chirp3-HD never hits Error 13520!
  const blocks: string[] = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (Buffer.byteLength(candidate, 'utf8') <= maxSayBytes) {
      current = candidate;
    } else {
      if (current) blocks.push(current);
      current = sentence;
    }
  }
  if (current) blocks.push(current);

  return blocks;
}

function buildInlineTenglishTwiml(segments: string[], voiceName: VoiceOptionId): string {
  const voiceMap: Record<VoiceOptionId, string> = {
    Aoede: 'Google.te-IN-Chirp3-HD-Aoede',
    Leda: 'Google.te-IN-Chirp3-HD-Leda',
    Zephyr: 'Google.te-IN-Chirp3-HD-Zephyr',
    Kore: 'Google.te-IN-Chirp3-HD-Kore',
  };
  const twilioVoice = voiceMap[voiceName] || 'Google.te-IN-Chirp3-HD-Aoede';
  const safeSentences = splitIntoChirpSafeSentences(segments, 240);
  const fluidBlocks = packSentencesIntoFluidSayBlocks(safeSentences, 950);
  const sayTags = fluidBlocks
    .map((block) => `  <Say voice="${twilioVoice}" language="te-IN">${escapeXml(block)}</Say>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Pause length="1"/>\n${sayTags}\n</Response>`;
}

// Detect real human speech in 16kHz PCM16 LE base64 audio so silence nudges cancel immediately when user speaks
function hasSpeechEnergyPcm16Base64(pcm16Base64: string, rmsThreshold = 0.025): boolean {
  try {
    const buf = Buffer.from(pcm16Base64, 'base64');
    const sampleCount = Math.floor(buf.length / 2);
    if (sampleCount === 0) return false;
    let sumSq = 0;
    // Stride by 2 samples for low CPU overhead while preserving accurate RMS
    let counted = 0;
    for (let i = 0; i + 1 < buf.length; i += 4) {
      const sample = buf.readInt16LE(i) / 32768;
      sumSq += sample * sample;
      counted++;
    }
    if (counted === 0) return false;
    const rms = Math.sqrt(sumSq / counted);
    return rms >= rmsThreshold;
  } catch {
    return false;
  }
}

const SILENCE_NUDGE_PROMPTS = [
  '(అవతలి వాళ్లు 3 నుంచి 4 సెకన్లుగా ఏం మాట్లాడలేదు. చాలా మృదువుగా, ప్రశాంతంగా: "హలో అండీ, వినిపిస్తుందా?" అని మాత్రమే అడిగి ఆగు.)',
  '(రెండోసారి కూడా ఇంకా రిప్లై రాలేదు. మృదువుగా, మర్యాదగా: "హలో అండీ, నా వాయిస్ వినిపిస్తుందా?" అని మాత్రమే అడిగి ఆగు.)',
];

const SILENCE_POLITE_END_PROMPT =
  '(రెండు సార్లు అడిగినా ఇంకా రిప్లై రాలేదు. ఇప్పుడు చాలా మర్యాదగా, వార్మ్‌గా: "సిగ్నల్ సరిగ్గా లేనట్టుంది అండీ, ఇబ్బంది లేదు, నేను తర్వాత మళ్లీ కాల్ చేస్తాను. థ్యాంక్యూ అండీ." అని చెప్పి కాల్ ముగించు.)';

function sanitizeServices(input: unknown): ServiceFocus[] {
  if (!Array.isArray(input)) return ['web_app', 'mobile_app', 'meta_ads'];
  const filtered = input.filter((item): item is ServiceFocus =>
    typeof item === 'string' && ALLOWED_SERVICES.includes(item as ServiceFocus)
  );
  return filtered.length > 0 ? filtered : ['web_app', 'mobile_app', 'meta_ads'];
}

function sanitizeVoice(input: unknown): VoiceOptionId {
  return typeof input === 'string' && ALLOWED_VOICES.includes(input as VoiceOptionId)
    ? (input as VoiceOptionId)
    : 'Aoede';
}

function sanitizeText(input: unknown, maxLen = 300): string {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0, maxLen);
}

function normalizeCallStatus(raw: string | undefined): CallStatus {
  const val = (raw || '').toLowerCase();
  const allowed: CallStatus[] = [
    'queued',
    'initiated',
    'ringing',
    'in-progress',
    'completed',
    'busy',
    'no-answer',
    'failed',
    'canceled',
  ];
  return allowed.includes(val as CallStatus) ? (val as CallStatus) : 'in-progress';
}

// Validate Twilio request signature when running behind public HTTPS URL
function verifyTwilioWebhookSignature(req: Request): boolean {
  const creds = getTwilioCredentials();
  if (!creds) return false;
  const signature = req.header('x-twilio-signature');
  if (!signature) return false;

  const baseUrl = resolvePublicBaseUrl(req);
  if (!baseUrl) return false;
  const fullUrl = `${baseUrl}${req.originalUrl}`;
  const params = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, string>;

  try {
    return twilio.validateRequest(creds.authToken, signature, fullUrl, params);
  } catch {
    return false;
  }
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  const httpServer = http.createServer(app);

  // WebSocket servers attached via HTTP upgrade
  const wssDashboard = new WebSocketServer({ noServer: true });
  const wssTwilioMedia = new WebSocketServer({ noServer: true });
  const wssLiveSimulator = new WebSocketServer({ noServer: true });

  const dashboardClients = new Set<WebSocket>();

  function broadcastDashboard(payload: Record<string, unknown>): void {
    const serialized = JSON.stringify(payload);
    for (const client of dashboardClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  async function finalizeAndSummarizeCall(callId: string, finalStatus?: CallStatus): Promise<void> {
    const existing = store.getCall(callId);
    if (!existing) return;

    const endedAt = existing.endedAt || new Date().toISOString();
    const computedDuration =
      existing.durationSec > 0
        ? existing.durationSec
        : Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(existing.startedAt).getTime()) / 1000));

    const updated = store.updateCall(callId, {
      status: finalStatus || (existing.status === 'in-progress' || existing.status === 'ringing' ? 'completed' : existing.status),
      endedAt,
      durationSec: computedDuration,
    });

    if (updated) {
      broadcastDashboard({ type: 'call:updated', call: updated });
    }

    if (updated && !updated.summary) {
      try {
        const summary = await generateCallSummary(updated);
        const withSummary = store.setCallSummary(callId, summary);
        if (withSummary) {
          broadcastDashboard({ type: 'call:updated', call: withSummary });
          if (withSummary.leadId) {
            const stageMap: Record<string, LeadStage> = {
              Interested: 'Interested',
              'Follow-up Requested': 'Follow-up',
              'Callback Scheduled': 'Follow-up',
              'Not Interested': 'Not Interested',
            };
            const mappedStage = stageMap[summary.outcome];
            if (mappedStage) {
              const updatedLead = store.updateLead(withSummary.leadId, { stage: mappedStage });
              if (updatedLead) {
                broadcastDashboard({ type: 'lead:updated', lead: updatedLead });
              }
            }
          }
        }
      } catch {
        // Fallback summary already handles Gemini credit/network errors inside generateCallSummary
      }
    }
  }

  wssDashboard.on('connection', (ws) => {
    dashboardClients.add(ws);
    ws.send(
      JSON.stringify({
        type: 'init',
        calls: store.getCalls(),
        leads: store.getLeads(),
      })
    );
    ws.on('close', () => {
      dashboardClients.delete(ws);
    });
  });

  // =========================================================================
  // 1. TWILIO MEDIA STREAMS <-> GEMINI 3.8 LIVE REAL-TIME AUDIO BRIDGE
  // =========================================================================
  wssTwilioMedia.on('connection', (twilioWs) => {
    let streamSid = '';
    let callId = '';
    let liveSession: Awaited<ReturnType<ReturnType<typeof getGeminiClient>['live']['connect']>> | null = null;
    let sessionReady = false;
    let closed = false;
    let silenceTimer: NodeJS.Timeout | null = null;
    let silenceNudgeCount = 0;
    let pendingPoliteHangup = false;
    let politeHangupTimer: NodeJS.Timeout | null = null;
    let lastModelAudioAt = 0;

    const clearSilenceTimer = () => {
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      if (politeHangupTimer) {
        clearTimeout(politeHangupTimer);
        politeHangupTimer = null;
      }
    };

    const scheduleSilenceNudge = () => {
      clearSilenceTimer();
      if (closed || !liveSession || !sessionReady) return;
      if (pendingPoliteHangup) {
        // Allow the polite goodbye audio to finish draining to Twilio, then close cleanly
        politeHangupTimer = setTimeout(() => {
          if (!closed && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.close();
          }
          cleanup();
        }, 2000);
        return;
      }
      // 3.5 seconds quiet -> try 1, then try 2, then polite goodbye and end
      const delayMs = silenceNudgeCount === 0 ? 3500 : 3800;
      silenceTimer = setTimeout(() => {
        if (closed || !liveSession || !sessionReady) return;
        let promptText: string;
        if (silenceNudgeCount < SILENCE_NUDGE_PROMPTS.length) {
          promptText = SILENCE_NUDGE_PROMPTS[silenceNudgeCount];
          silenceNudgeCount += 1;
        } else {
          promptText = SILENCE_POLITE_END_PROMPT;
          pendingPoliteHangup = true;
        }
        try {
          liveSession.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: promptText }] }],
            turnComplete: true,
          });
        } catch {
          // ignore if session closed
        }
      }, delayMs);
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      sessionReady = false;
      clearSilenceTimer();
      try {
        liveSession?.close();
      } catch {
        // ignore close error
      }
      liveSession = null;
      if (callId) {
        void finalizeAndSummarizeCall(callId, 'completed');
      }
    };

    twilioWs.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          event: string;
          start?: {
            streamSid: string;
            callSid: string;
            customParameters?: Record<string, string>;
          };
          media?: { payload: string; track?: string };
        };

        if (msg.event === 'start' && msg.start) {
          streamSid = msg.start.streamSid;
          const callSid = msg.start.callSid;
          callId = msg.start.customParameters?.callId || store.getCallBySid(callSid)?.id || '';
          const callRecord = callId ? store.getCall(callId) : undefined;

          if (!callRecord) {
            console.warn('[Twilio Media] Start received without matching callRecord:', callSid);
            twilioWs.close();
            return;
          }

          const updated = store.updateCall(callRecord.id, {
            status: 'in-progress',
            callSid: callSid || callRecord.callSid,
          });
          if (updated) {
            store.appendTranscript(callRecord.id, {
              id: crypto.randomUUID(),
              speaker: 'system',
              text: `${getAgentPersonaName(callRecord.voiceName)} connected on live audio stream.`,
              timestamp: new Date().toISOString(),
            });
            broadcastDashboard({ type: 'call:updated', call: store.getCall(callRecord.id) });
          }

          const ai = getGeminiClient();
          const systemInstruction = buildTenglishSystemInstruction({
            leadName: callRecord.leadName,
            businessName: callRecord.businessName,
            businessType: callRecord.businessType,
            focusServices: callRecord.focusServices,
            customNotes: callRecord.customNotes,
            voiceName: callRecord.voiceName,
          });

          liveSession = await ai.live.connect({
            model: 'gemini-3.8-live',
            config: {
              responseModalities: [Modality.AUDIO],
              temperature: 0.65,
              speechConfig: {
                languageCode: 'te-IN',
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: callRecord.voiceName },
                },
              },
              realtimeInputConfig: {
                automaticActivityDetection: {
                  disabled: false,
                  startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
                  endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                  prefixPaddingMs: 120,
                  silenceDurationMs: 550,
                },
                activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              systemInstruction,
            },
            callbacks: {
              onmessage: (message: LiveServerMessage) => {
                if (closed) return;
                const content = message.serverContent;

                if (content?.interrupted && streamSid && twilioWs.readyState === WebSocket.OPEN) {
                  clearSilenceTimer();
                  silenceNudgeCount = 0;
                  pendingPoliteHangup = false;
                  twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
                }

                if (content?.inputTranscription?.text?.trim()) {
                  clearSilenceTimer();
                  silenceNudgeCount = 0;
                  pendingPoliteHangup = false;
                  const rec = store.appendTranscript(callRecord.id, {
                    id: crypto.randomUUID(),
                    speaker: 'lead',
                    text: content.inputTranscription.text.trim(),
                    timestamp: new Date().toISOString(),
                  });
                  if (rec) broadcastDashboard({ type: 'call:updated', call: rec });
                }

                if (content?.outputTranscription?.text?.trim()) {
                  const rec = store.appendTranscript(callRecord.id, {
                    id: crypto.randomUUID(),
                    speaker: 'agent',
                    text: content.outputTranscription.text.trim(),
                    timestamp: new Date().toISOString(),
                  });
                  if (rec) broadcastDashboard({ type: 'call:updated', call: rec });
                }

                for (const part of content?.modelTurn?.parts ?? []) {
                  if (part.inlineData?.data && streamSid && twilioWs.readyState === WebSocket.OPEN) {
                    clearSilenceTimer();
                    lastModelAudioAt = Date.now();
                    const mulawPayload = pcm24kBase64ToMulaw8kBase64(part.inlineData.data);
                    if (mulawPayload) {
                      // Send crisp 20ms (160-byte) telephony frames for low-jitter audio and instant barge-in clear
                      const mulawBytes = Buffer.from(mulawPayload, 'base64');
                      const frameSize = 160;
                      for (let offset = 0; offset < mulawBytes.length; offset += frameSize) {
                        const frame = mulawBytes.subarray(offset, offset + frameSize);
                        twilioWs.send(
                          JSON.stringify({
                            event: 'media',
                            streamSid,
                            media: { payload: frame.toString('base64') },
                          })
                        );
                      }
                    }
                  }
                }

                if (content?.turnComplete) {
                  scheduleSilenceNudge();
                }
              },
              onerror: (err) => {
                const readable = formatGeminiError(err, 'Voice session encountered a connection error.');
                const rec = store.appendTranscript(callRecord.id, {
                  id: crypto.randomUUID(),
                  speaker: 'system',
                  text: readable,
                  timestamp: new Date().toISOString(),
                });
                if (rec) broadcastDashboard({ type: 'call:updated', call: rec });
              },
              onclose: () => {
                clearSilenceTimer();
                if (!closed && twilioWs.readyState === WebSocket.OPEN) {
                  twilioWs.close();
                }
              },
            },
          });

          sessionReady = true;
          // Kick off in warm, calm, polite Warangal Telugu (100% Telugu script for pure native accent)
          liveSession.sendClientContent({
            turns: [
              {
                role: 'user',
                parts: [
                  {
                    text: 'హలో? (ఇప్పుడే కాల్ లిఫ్ట్ చేశారు. వరంగల్ నుంచి వచ్చిన మర్యాదగల, వార్మ్, ఫ్రెండ్లీ అమ్మాయిలా మీడియం-స్లో స్పీడ్‌లో చిరునవ్వుతో సాఫ్ట్‌గా హలో చెప్పి పేరు కన్ఫర్మ్ చేసి, వాళ్లు మాట్లాడేందుకు ప్రశాంతంగా ఆగు.)',
                  },
                ],
              },
            ],
            turnComplete: true,
          });
        } else if (msg.event === 'media' && msg.media?.payload && sessionReady && liveSession) {
          if (msg.media.track && msg.media.track !== 'inbound') return;
          const pcm16k = mulaw8kBase64ToPcm16kBase64(msg.media.payload);
          if (pcm16k) {
            if (
              silenceTimer &&
              Date.now() - lastModelAudioAt > 1200 &&
              hasSpeechEnergyPcm16Base64(pcm16k, 0.045)
            ) {
              clearSilenceTimer();
              silenceNudgeCount = 0;
              pendingPoliteHangup = false;
            }
            liveSession.sendRealtimeInput({
              audio: { data: pcm16k, mimeType: 'audio/pcm;rate=16000' },
            });
          }
        } else if (msg.event === 'stop') {
          cleanup();
        }
      } catch (err) {
        console.error('[Twilio Media] Handler error:', err instanceof Error ? err.message : err);
      }
    });

    twilioWs.on('close', cleanup);
    twilioWs.on('error', cleanup);
  });

  // =========================================================================
  // 2. BROWSER LIVE VOICE REHEARSAL <-> GEMINI 3.8 LIVE
  // =========================================================================
  wssLiveSimulator.on('connection', (clientWs) => {
    let liveSession: Awaited<ReturnType<ReturnType<typeof getGeminiClient>['live']['connect']>> | null = null;
    let rehearsalCallId = '';
    let closed = false;
    let simSilenceTimer: NodeJS.Timeout | null = null;
    let simSilenceNudgeCount = 0;
    let simPendingPoliteHangup = false;
    let simPoliteHangupTimer: NodeJS.Timeout | null = null;
    let simLastModelAudioAt = 0;

    const clearSimSilenceTimer = () => {
      if (simSilenceTimer) {
        clearTimeout(simSilenceTimer);
        simSilenceTimer = null;
      }
      if (simPoliteHangupTimer) {
        clearTimeout(simPoliteHangupTimer);
        simPoliteHangupTimer = null;
      }
    };

    const scheduleSimSilenceNudge = () => {
      clearSimSilenceTimer();
      if (closed || !liveSession) return;
      if (simPendingPoliteHangup) {
        simPoliteHangupTimer = setTimeout(() => {
          if (!closed && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'ended', callId: rehearsalCallId }));
          }
          closeSimulator();
        }, 2200);
        return;
      }
      // 3.5–4 seconds quiet -> gentle check-in (2 tries), then polite end
      const delayMs = simSilenceNudgeCount === 0 ? 3800 : 4000;
      simSilenceTimer = setTimeout(() => {
        if (closed || !liveSession) return;
        let promptText: string;
        if (simSilenceNudgeCount < SILENCE_NUDGE_PROMPTS.length) {
          promptText = SILENCE_NUDGE_PROMPTS[simSilenceNudgeCount];
          simSilenceNudgeCount += 1;
        } else {
          promptText = SILENCE_POLITE_END_PROMPT;
          simPendingPoliteHangup = true;
        }
        try {
          liveSession.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: promptText }] }],
            turnComplete: true,
          });
        } catch {
          // ignore if session closed
        }
      }, delayMs);
    };

    const closeSimulator = () => {
      if (closed) return;
      closed = true;
      clearSimSilenceTimer();
      try {
        liveSession?.close();
      } catch {
        // ignore
      }
      liveSession = null;
      if (rehearsalCallId) {
        void finalizeAndSummarizeCall(rehearsalCallId, 'completed');
      }
    };

    clientWs.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: 'start' | 'audio' | 'text' | 'stop';
          audio?: string;
          text?: string;
          config?: {
            leadId?: string;
            leadName?: string;
            businessName?: string;
            businessType?: string;
            focusServices?: ServiceFocus[];
            customNotes?: string;
            voiceName?: VoiceOptionId;
            greetingOverride?: string;
          };
        };

        if (msg.type === 'start') {
          if (liveSession) return;
          const cfg = msg.config || {};
          const voiceName = sanitizeVoice(cfg.voiceName);
          const focusServices = sanitizeServices(cfg.focusServices);
          const leadName = sanitizeText(cfg.leadName, 80) || 'Rehearsal Lead';
          const businessName = sanitizeText(cfg.businessName, 120) || 'Hyderabad Local Business';
          const businessType = sanitizeText(cfg.businessType, 120) || 'SMB';
          const customNotes = sanitizeText(cfg.customNotes, 500);
          const greetingOverride = sanitizeText(cfg.greetingOverride, 300);

          const callRecord: CallRecord = {
            id: `reh-${crypto.randomUUID().slice(0, 8)}`,
            leadId: sanitizeText(cfg.leadId, 60) || undefined,
            leadName,
            businessName,
            businessType,
            toNumber: 'Browser Rehearsal',
            fromNumber: 'WebDevs Studio',
            voiceName,
            focusServices,
            customNotes,
            channel: 'rehearsal',
            status: 'in-progress',
            startedAt: new Date().toISOString(),
            durationSec: 0,
            transcript: [
              {
                id: crypto.randomUUID(),
                speaker: 'system',
                text: `Live voice rehearsal started with ${getAgentPersonaName(voiceName)} (${voiceName}).`,
                timestamp: new Date().toISOString(),
              },
            ],
          };

          rehearsalCallId = callRecord.id;
          store.addCall(callRecord);
          broadcastDashboard({ type: 'call:created', call: callRecord });

          const ai = getGeminiClient();
          const systemInstruction = buildTenglishSystemInstruction({
            leadName,
            businessName,
            businessType,
            focusServices,
            customNotes,
            voiceName,
            greetingOverride,
          });

          liveSession = await ai.live.connect({
            model: 'gemini-3.8-live',
            config: {
              responseModalities: [Modality.AUDIO],
              temperature: 0.65,
              speechConfig: {
                languageCode: 'te-IN',
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName },
                },
              },
              realtimeInputConfig: {
                automaticActivityDetection: {
                  disabled: false,
                  startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
                  endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
                  prefixPaddingMs: 120,
                  silenceDurationMs: 550,
                },
                activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
              },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              systemInstruction,
            },
            callbacks: {
              onmessage: (message: LiveServerMessage) => {
                if (closed || clientWs.readyState !== WebSocket.OPEN) return;
                const content = message.serverContent;

                if (content?.interrupted) {
                  clearSimSilenceTimer();
                  simSilenceNudgeCount = 0;
                  simPendingPoliteHangup = false;
                  clientWs.send(JSON.stringify({ type: 'interrupted' }));
                }

                if (content?.inputTranscription?.text?.trim()) {
                  clearSimSilenceTimer();
                  simSilenceNudgeCount = 0;
                  simPendingPoliteHangup = false;
                  const rec = store.appendTranscript(rehearsalCallId, {
                    id: crypto.randomUUID(),
                    speaker: 'lead',
                    text: content.inputTranscription.text.trim(),
                    timestamp: new Date().toISOString(),
                  });
                  if (rec) {
                    clientWs.send(JSON.stringify({ type: 'transcript', call: rec }));
                    broadcastDashboard({ type: 'call:updated', call: rec });
                  }
                }

                if (content?.outputTranscription?.text?.trim()) {
                  const rec = store.appendTranscript(rehearsalCallId, {
                    id: crypto.randomUUID(),
                    speaker: 'agent',
                    text: content.outputTranscription.text.trim(),
                    timestamp: new Date().toISOString(),
                  });
                  if (rec) {
                    clientWs.send(JSON.stringify({ type: 'transcript', call: rec }));
                    broadcastDashboard({ type: 'call:updated', call: rec });
                  }
                }

                for (const part of content?.modelTurn?.parts ?? []) {
                  if (part.inlineData?.data) {
                    clearSimSilenceTimer();
                    simLastModelAudioAt = Date.now();
                    clientWs.send(JSON.stringify({ type: 'audio', audio: part.inlineData.data }));
                  }
                }

                if (content?.turnComplete) {
                  scheduleSimSilenceNudge();
                }
              },
              onerror: (err) => {
                const readable = formatGeminiError(
                  err,
                  'Gemini Live audio stream error. Please check GEMINI_API_KEY and billing credits in AI Studio.'
                );
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(
                    JSON.stringify({
                      type: 'error',
                      error: readable,
                    })
                  );
                }
              },
              onclose: () => {
                clearSimSilenceTimer();
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(JSON.stringify({ type: 'ended', callId: rehearsalCallId }));
                }
                closeSimulator();
              },
            },
          });

          clientWs.send(JSON.stringify({ type: 'ready', call: callRecord }));

          // Kick off in warm, calm, polite Warangal Telugu (100% Telugu script for pure native accent)
          liveSession.sendClientContent({
            turns: [
              {
                role: 'user',
                parts: [
                  {
                    text: 'హలో? (ఇప్పుడే కాల్ లిఫ్ట్ చేశారు. వరంగల్ నుంచి వచ్చిన మర్యాదగల, వార్మ్, ఫ్రెండ్లీ అమ్మాయిలా మీడియం-స్లో స్పీడ్‌లో చిరునవ్వుతో సాఫ్ట్‌గా హలో చెప్పి పేరు కన్ఫర్మ్ చేసి, వాళ్లు మాట్లాడేందుకు ప్రశాంతంగా ఆగు.)',
                  },
                ],
              },
            ],
            turnComplete: true,
          });
        } else if (msg.type === 'audio' && msg.audio && liveSession) {
          if (
            simSilenceTimer &&
            Date.now() - simLastModelAudioAt > 1200 &&
            hasSpeechEnergyPcm16Base64(msg.audio, 0.045)
          ) {
            clearSimSilenceTimer();
            simSilenceNudgeCount = 0;
            simPendingPoliteHangup = false;
          }
          liveSession.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (msg.type === 'text' && msg.text && liveSession) {
          const cleanText = sanitizeText(msg.text, 400);
          if (cleanText) {
            clearSimSilenceTimer();
            simSilenceNudgeCount = 0;
            simPendingPoliteHangup = false;
            const rec = store.appendTranscript(rehearsalCallId, {
              id: crypto.randomUUID(),
              speaker: 'lead',
              text: cleanText,
              timestamp: new Date().toISOString(),
            });
            if (rec) {
              clientWs.send(JSON.stringify({ type: 'transcript', call: rec }));
              broadcastDashboard({ type: 'call:updated', call: rec });
            }
            liveSession.sendClientContent({
              turns: [{ role: 'user', parts: [{ text: cleanText }] }],
              turnComplete: true,
            });
          }
        } else if (msg.type === 'stop') {
          closeSimulator();
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: 'ended', callId: rehearsalCallId }));
          }
        }
      } catch (err) {
        const message = formatGeminiError(err, 'Live session failed to start.');
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ type: 'error', error: message }));
        }
      }
    });

    clientWs.on('close', closeSimulator);
    clientWs.on('error', closeSimulator);
  });

  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/ws/dashboard') {
        wssDashboard.handleUpgrade(request, socket, head, (ws) => {
          wssDashboard.emit('connection', ws, request);
        });
      } else if (url.pathname === '/ws/twilio-media') {
        wssTwilioMedia.handleUpgrade(request, socket, head, (ws) => {
          wssTwilioMedia.emit('connection', ws, request);
        });
      } else if (url.pathname === '/ws/live-simulator') {
        wssLiveSimulator.handleUpgrade(request, socket, head, (ws) => {
          wssLiveSimulator.emit('connection', ws, request);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  // =========================================================================
  // 3. REST API ROUTES
  // =========================================================================

  // Public health probe used to detect whether Twilio can reach webhooks directly
  app.get('/api/twilio/health', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.get('/api/config/status', async (req: Request, res: Response) => {
    const creds = getTwilioCredentials();
    const publicBaseUrl = resolvePublicBaseUrl(req);
    const hasPublicUrl = isPublicHttpsUrl(publicBaseUrl);
    const webhookReachable = hasPublicUrl ? await probeWebhookReachable(publicBaseUrl) : false;
    const payload: ServerConfigStatus = {
      twilioConfigured: Boolean(creds),
      twilioFromNumberMasked: creds ? maskPhoneNumber(creds.phoneNumber) : null,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
      publicWebhookBaseUrl: publicBaseUrl,
      hasPublicWebhookUrl: hasPublicUrl,
      twilioWebhookReachable: webhookReachable,
      twilioCallMode: webhookReachable ? 'live-stream' : 'inline-twiml',
    };
    res.json(payload);
  });

  // Leads CRUD
  app.get('/api/leads', (_req: Request, res: Response) => {
    res.json({ leads: store.getLeads() });
  });

  app.post('/api/leads', (req: Request, res: Response) => {
    const name = sanitizeText(req.body?.name, 80);
    const phone = sanitizeText(req.body?.phone, 25);
    const businessName = sanitizeText(req.body?.businessName, 120);
    const businessType = sanitizeText(req.body?.businessType, 120) || 'Local Business';
    const location = sanitizeText(req.body?.location, 100) || 'Hyderabad';
    const notes = sanitizeText(req.body?.notes, 500);
    const focusServices = sanitizeServices(req.body?.focusServices);

    if (!name || !businessName) {
      res.status(400).json({ error: 'Lead name and business name are required.' });
      return;
    }
    if (!isValidE164Phone(phone)) {
      res.status(400).json({
        error: 'Phone number must be in E.164 international format (e.g., +919876543210 or +14155552671).',
      });
      return;
    }

    const lead: Lead = {
      id: `lead-${crypto.randomUUID().slice(0, 8)}`,
      name,
      phone,
      businessName,
      businessType,
      location,
      focusServices,
      notes,
      stage: 'New',
      createdAt: new Date().toISOString(),
    };

    store.addLead(lead);
    broadcastDashboard({ type: 'lead:created', lead });
    res.status(201).json({ lead });
  });

  app.patch('/api/leads/:id', (req: Request, res: Response) => {
    const id = sanitizeText(req.params.id, 60);
    const existing = store.getLead(id);
    if (!existing) {
      res.status(404).json({ error: 'Lead not found.' });
      return;
    }

    const patch: Partial<Lead> = {};
    if (req.body?.name !== undefined) patch.name = sanitizeText(req.body.name, 80) || existing.name;
    if (req.body?.phone !== undefined) {
      const phone = sanitizeText(req.body.phone, 25);
      if (!isValidE164Phone(phone)) {
        res.status(400).json({ error: 'Phone number must be in E.164 format (e.g. +919876543210).' });
        return;
      }
      patch.phone = phone;
    }
    if (req.body?.businessName !== undefined) patch.businessName = sanitizeText(req.body.businessName, 120);
    if (req.body?.businessType !== undefined) patch.businessType = sanitizeText(req.body.businessType, 120);
    if (req.body?.location !== undefined) patch.location = sanitizeText(req.body.location, 100);
    if (req.body?.notes !== undefined) patch.notes = sanitizeText(req.body.notes, 500);
    if (req.body?.focusServices !== undefined) patch.focusServices = sanitizeServices(req.body.focusServices);
    if (
      typeof req.body?.stage === 'string' &&
      ALLOWED_LEAD_STAGES.includes(req.body.stage as LeadStage)
    ) {
      patch.stage = req.body.stage as LeadStage;
    }

    const updated = store.updateLead(id, patch);
    if (updated) broadcastDashboard({ type: 'lead:updated', lead: updated });
    res.json({ lead: updated });
  });

  app.delete('/api/leads/:id', (req: Request, res: Response) => {
    const id = sanitizeText(req.params.id, 60);
    const deleted = store.deleteLead(id);
    if (!deleted) {
      res.status(404).json({ error: 'Lead not found.' });
      return;
    }
    broadcastDashboard({ type: 'lead:deleted', id });
    res.json({ ok: true });
  });

  // Calls listing & detail
  app.get('/api/calls', (_req: Request, res: Response) => {
    res.json({ calls: store.getCalls() });
  });

  app.get('/api/calls/:id', (req: Request, res: Response) => {
    const call = store.getCall(sanitizeText(req.params.id, 60));
    if (!call) {
      res.status(404).json({ error: 'Call record not found.' });
      return;
    }
    res.json({ call });
  });

  // Initiate real Twilio Outbound AI Voice Call
  app.post('/api/calls/initiate', async (req: Request, res: Response) => {
    const creds = getTwilioCredentials();
    if (!creds) {
      res.status(503).json({
        error:
          'Twilio credentials are not configured yet. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in Settings > Secrets, then restart the app.',
      });
      return;
    }

    if (!process.env.GEMINI_API_KEY?.trim()) {
      res.status(503).json({
        error: 'GEMINI_API_KEY is not configured. Please check Settings > Secrets.',
      });
      return;
    }

    const toNumber = sanitizeText(req.body?.toNumber, 25);
    if (!isValidE164Phone(toNumber)) {
      res.status(400).json({
        error: 'Enter a valid destination phone number in E.164 format (for example, +919876543210 or +14155552671).',
      });
      return;
    }

    const publicBaseUrl = resolvePublicBaseUrl(req);
    const webhookReachable = isPublicHttpsUrl(publicBaseUrl)
      ? await probeWebhookReachable(publicBaseUrl)
      : false;
    const callMode: 'live-stream' | 'inline-twiml' = webhookReachable ? 'live-stream' : 'inline-twiml';

    const leadId = sanitizeText(req.body?.leadId, 60) || undefined;
    const leadName = sanitizeText(req.body?.leadName, 80) || 'Lead';
    const businessName = sanitizeText(req.body?.businessName, 120) || 'Your Business';
    const businessType = sanitizeText(req.body?.businessType, 120) || 'Local Business';
    const customNotes = sanitizeText(req.body?.customNotes, 500);
    const focusServices = sanitizeServices(req.body?.focusServices);
    const voiceName = sanitizeVoice(req.body?.voiceName);

    const callId = `call-${crypto.randomUUID().slice(0, 10)}`;
    const record: CallRecord = {
      id: callId,
      leadId,
      leadName,
      businessName,
      businessType,
      toNumber,
      fromNumber: maskPhoneNumber(creds.phoneNumber),
      voiceName,
      focusServices,
      customNotes,
      channel: 'twilio',
      callMode,
      status: 'queued',
      startedAt: new Date().toISOString(),
      durationSec: 0,
      transcript: [
        {
          id: crypto.randomUUID(),
          speaker: 'system',
          text:
            callMode === 'live-stream'
              ? `Dialing ${toNumber} via Twilio Live Audio Stream with ${getAgentPersonaName(voiceName)} (${voiceName})...`
              : `Crafting personalized Hyderabadi Tenglish pitch and dialing ${toNumber} via Twilio inline voice...`,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    store.addCall(record);
    broadcastDashboard({ type: 'call:created', call: record });

    if (leadId) {
      const updatedLead = store.updateLead(leadId, {
        lastCalledAt: record.startedAt,
        stage: store.getLead(leadId)?.stage === 'New' ? 'Contacted' : store.getLead(leadId)?.stage,
      });
      if (updatedLead) broadcastDashboard({ type: 'lead:updated', lead: updatedLead });
    }

    try {
      const client = twilio(creds.accountSid, creds.authToken);
      let twilioCall;

      if (callMode === 'live-stream') {
        const voiceWebhookUrl = `${publicBaseUrl}/api/twilio/voice?callId=${encodeURIComponent(callId)}`;
        const statusWebhookUrl = `${publicBaseUrl}/api/twilio/status?callId=${encodeURIComponent(callId)}`;

        twilioCall = await client.calls.create({
          to: toNumber,
          from: creds.phoneNumber,
          url: voiceWebhookUrl,
          method: 'POST',
          statusCallback: statusWebhookUrl,
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        });
      } else {
        // Private dev preview cannot receive inbound Twilio webhooks (302 auth proxy).
        // Generate tailored Hyderabadi Tenglish pitch via Gemini and pass inline TwiML directly!
        const segments = await generateInlinePhonePitch({
          leadName,
          businessName,
          businessType,
          focusServices,
          customNotes,
          voiceName,
        });

        const twiml = buildInlineTenglishTwiml(segments, voiceName);
        twilioCall = await client.calls.create({
          to: toNumber,
          from: creds.phoneNumber,
          twiml,
        });

        // Record the exact spoken Tenglish pitch in the live transcript feed
        for (const seg of segments) {
          store.appendTranscript(callId, {
            id: crypto.randomUUID(),
            speaker: 'agent',
            text: seg,
            timestamp: new Date().toISOString(),
          });
        }

        // Poll Twilio REST API for live ringing/in-progress/completed updates without needing public webhook
        const pollCallSid = twilioCall.sid;
        const terminalStatuses: CallStatus[] = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
        let attempts = 0;
        const pollTimer = setInterval(async () => {
          attempts += 1;
          try {
            const latest = await client.calls(pollCallSid).fetch();
            const normalized = normalizeCallStatus(latest.status);
            const dur = Number(latest.duration || 0);
            const current = store.getCall(callId);
            if (!current) {
              clearInterval(pollTimer);
              return;
            }
            const isTerminal = terminalStatuses.includes(normalized);
            store.updateCall(callId, {
              status: normalized,
              durationSec: Number.isFinite(dur) && dur > 0 ? dur : current.durationSec,
              endedAt: isTerminal ? new Date().toISOString() : current.endedAt,
            });
            const refreshed = store.getCall(callId);
            if (refreshed) broadcastDashboard({ type: 'call:updated', call: refreshed });

            if (isTerminal || attempts >= 72) {
              clearInterval(pollTimer);
              if (isTerminal) {
                try {
                  const notifs = await client.calls(pollCallSid).notifications.list({ limit: 3 });
                  const errNotif = notifs.find((n) => String(n.log) === '0');
                  if (errNotif) {
                    const twilioErrMsg = `Twilio Error ${errNotif.errorCode}: ${decodeURIComponent(
                      (errNotif.messageText || '').replace(/\+/g, ' ')
                    ).slice(0, 180)}`;
                    store.updateCall(callId, { errorMessage: twilioErrMsg });
                    store.appendTranscript(callId, {
                      id: crypto.randomUUID(),
                      speaker: 'system',
                      text: twilioErrMsg,
                      timestamp: new Date().toISOString(),
                    });
                  }
                } catch {
                  // ignore notification fetch failure
                }
                void finalizeAndSummarizeCall(callId, normalized);
              }
            }
          } catch {
            if (attempts >= 72) clearInterval(pollTimer);
          }
        }, 2500);
      }

      const updated = store.updateCall(callId, {
        callSid: twilioCall.sid,
        status: normalizeCallStatus(twilioCall.status),
      });
      if (updated) broadcastDashboard({ type: 'call:updated', call: updated });

      res.status(201).json({ call: updated });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Twilio failed to place the outbound call.';
      const failed = store.updateCall(callId, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        errorMessage: errMsg,
      });
      if (failed) {
        store.appendTranscript(callId, {
          id: crypto.randomUUID(),
          speaker: 'system',
          text: `Call failed: ${errMsg}`,
          timestamp: new Date().toISOString(),
        });
        broadcastDashboard({ type: 'call:updated', call: store.getCall(callId) });
      }
      res.status(502).json({ error: errMsg, call: store.getCall(callId) });
    }
  });

  // Hang up an active Twilio call
  app.post('/api/calls/:id/hangup', async (req: Request, res: Response) => {
    const id = sanitizeText(req.params.id, 60);
    const call = store.getCall(id);
    if (!call) {
      res.status(404).json({ error: 'Call not found.' });
      return;
    }
    if (call.channel !== 'twilio' || !call.callSid) {
      const ended = store.updateCall(id, { status: 'completed', endedAt: new Date().toISOString() });
      if (ended) broadcastDashboard({ type: 'call:updated', call: ended });
      res.json({ call: ended });
      return;
    }

    const creds = getTwilioCredentials();
    if (!creds) {
      res.status(503).json({ error: 'Twilio credentials are not configured.' });
      return;
    }

    try {
      const client = twilio(creds.accountSid, creds.authToken);
      await client.calls(call.callSid).update({ status: 'completed' });
      await finalizeAndSummarizeCall(id, 'completed');
      res.json({ call: store.getCall(id) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to end Twilio call.';
      res.status(502).json({ error: msg });
    }
  });

  // Manual or retry AI post-call summary
  app.post('/api/calls/:id/summarize', async (req: Request, res: Response) => {
    const id = sanitizeText(req.params.id, 60);
    const call = store.getCall(id);
    if (!call) {
      res.status(404).json({ error: 'Call not found.' });
      return;
    }
    try {
      const summary = await generateCallSummary(call);
      const updated = store.setCallSummary(id, summary);
      if (updated) broadcastDashboard({ type: 'call:updated', call: updated });
      res.json({ call: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate call summary.';
      res.status(502).json({ error: msg });
    }
  });

  // Twilio Voice TwiML Webhook -> connects call directly to our Media Streams WebSocket
  app.post('/api/twilio/voice', (req: Request, res: Response) => {
    const callId = sanitizeText(req.query.callId, 60);
    const call = callId ? store.getCall(callId) : undefined;

    if (!call) {
      res.type('text/xml').send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this WebDevs call session could not be located.</Say><Hangup/></Response>'
      );
      return;
    }

    // Verify Twilio webhook signature whenever Twilio is configured
    if (getTwilioCredentials() && !verifyTwilioWebhookSignature(req)) {
      res.status(403).type('text/plain').send('Invalid Twilio signature');
      return;
    }

    const publicBaseUrl = resolvePublicBaseUrl(req);
    const wsBaseUrl = publicBaseUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
    const streamUrl = `${wsBaseUrl}/ws/twilio-media`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}">
      <Parameter name="callId" value="${escapeXml(call.id)}" />
    </Stream>
  </Connect>
</Response>`;

    res.type('text/xml').send(twiml);
  });

  // Twilio Status Callback Webhook
  app.post('/api/twilio/status', (req: Request, res: Response) => {
    const callId = sanitizeText(req.query.callId, 60);
    const callSid = sanitizeText(req.body?.CallSid, 80);
    const callStatus = normalizeCallStatus(req.body?.CallStatus);
    const durationRaw = Number(req.body?.CallDuration || 0);

    if (getTwilioCredentials() && !verifyTwilioWebhookSignature(req)) {
      res.status(403).type('text/plain').send('Invalid Twilio signature');
      return;
    }

    const call = (callId ? store.getCall(callId) : undefined) || (callSid ? store.getCallBySid(callSid) : undefined);
    if (call) {
      const terminalStatuses: CallStatus[] = ['completed', 'busy', 'no-answer', 'failed', 'canceled'];
      const isTerminal = terminalStatuses.includes(callStatus);

      store.updateCall(call.id, {
        status: callStatus,
        callSid: callSid || call.callSid,
        durationSec: Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : call.durationSec,
        endedAt: isTerminal ? new Date().toISOString() : call.endedAt,
      });

      const refreshed = store.getCall(call.id);
      if (refreshed) {
        broadcastDashboard({ type: 'call:updated', call: refreshed });
      }

      if (isTerminal) {
        void finalizeAndSummarizeCall(call.id, callStatus);
      }
    }

    res.status(200).send('OK');
  });

  // Tenglish Pitch Playbook Generator (Gemini 4 Hydrogen)
  app.post('/api/pitch/generate', async (req: Request, res: Response) => {
    try {
      const playbook = await generateTenglishPlaybook({
        leadName: sanitizeText(req.body?.leadName, 80) || 'Business Owner',
        businessName: sanitizeText(req.body?.businessName, 120) || 'Hyderabad Local Business',
        businessType: sanitizeText(req.body?.businessType, 120) || 'Retail / Services',
        focusServices: sanitizeServices(req.body?.focusServices),
        customNotes: sanitizeText(req.body?.customNotes, 500),
        voiceName: sanitizeVoice(req.body?.voiceName),
      });
      res.json({ playbook });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate Tenglish pitch playbook.';
      res.status(502).json({ error: message });
    }
  });

  // High-Fidelity Hyderabadi Tenglish Voice Audition (Gemini 3.8 Flash TTS)
  app.post('/api/pitch/preview-audio', async (req: Request, res: Response) => {
    const text = sanitizeText(req.body?.text, 700);
    if (!text) {
      res.status(400).json({ error: 'Provide spoken Tenglish text to synthesize.' });
      return;
    }
    try {
      const voiceName = sanitizeVoice(req.body?.voiceName);
      const audio = await synthesizeTenglishSpeech({ text, voiceName });
      res.json(audio);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to synthesize voice preview.';
      res.status(502).json({ error: message });
    }
  });

  // Guarantee /api/* routes always return JSON and never fall through to SPA HTML
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  app.use((err: unknown, req: Request, res: Response, next: (err?: unknown) => void) => {
    if (req.path.startsWith('/api')) {
      const message = err instanceof Error ? err.message : 'Internal server error.';
      res.status(500).json({ error: message });
      return;
    }
    next(err);
  });

  // =========================================================================
  // 4. VITE DEV MIDDLEWARE / PRODUCTION STATIC ASSETS
  // =========================================================================
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`WebDevs Voice server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start WebDevs Voice server:', err);
  process.exit(1);
});
