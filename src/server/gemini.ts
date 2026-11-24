import { GoogleGenAI, ThinkingLevel, Type, type Schema } from '@google/genai';
import type { CallRecord, CallSummary, PitchPlaybook, ServiceFocus, VoiceOptionId } from '../types.ts';
import { getAgentPersonaName, getAgentTeluguName } from './persona.ts';

let cachedAi: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in the server environment.');
  }
  if (!cachedAi) {
    cachedAi = new GoogleGenAI({
      apiKey,
      apiVersion: 'v1beta',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedAi;
}

export function isBillingOrQuotaError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('prepayment credits') ||
    msg.includes('credits are depleted') ||
    msg.includes('billing') ||
    msg.includes('payment required') ||
    msg.includes('quota exceeded') ||
    msg.includes('exceeded your current quota') ||
    msg.includes('402')
  );
}

function isTransientError(err: unknown): boolean {
  if (isBillingOrQuotaError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('503') ||
    msg.includes('429') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('high demand') ||
    msg.includes('temporarily')
  );
}

export function formatGeminiError(err: unknown, fallback: string): string {
  if (isBillingOrQuotaError(err)) {
    return 'Gemini API prepayment credits are depleted for this project. Top up credits at https://ai.studio/projects to re-enable live Gemini audio & AI generation.';
  }
  const raw = err instanceof Error ? err.message : String(err);
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: { message?: string }; message?: string };
      if (parsed.error?.message) {
        if (isBillingOrQuotaError(parsed.error.message)) {
          return 'Gemini API prepayment credits are depleted for this project. Top up credits at https://ai.studio/projects to re-enable live Gemini audio & AI generation.';
        }
        return parsed.error.message;
      }
      if (parsed.message) return parsed.message;
    } catch {
      // fall through
    }
  }
  return trimmed || fallback;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateStructuredJson<T>(prompt: string, responseSchema: Schema): Promise<T> {
  const ai = getGeminiClient();

  const attempts: { model: string; useThinking: boolean; delayBeforeMs: number }[] = [
    { model: 'gemini-4-hydrogen', useThinking: true, delayBeforeMs: 0 },
    { model: 'gemini-4-hydrogen', useThinking: true, delayBeforeMs: 650 },
    { model: 'gemini-3.1-flash-lite', useThinking: false, delayBeforeMs: 400 },
  ];

  let lastErr: unknown;
  for (const step of attempts) {
    if (step.delayBeforeMs > 0) {
      await sleep(step.delayBeforeMs);
    }
    try {
      const response = await ai.models.generateContent({
        model: step.model,
        contents: prompt,
        config: {
          ...(step.useThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
          responseMimeType: 'application/json',
          responseSchema,
        },
      });
      const raw = (response.text ?? '{}').trim();
      return JSON.parse(raw) as T;
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err)) {
        throw new Error(formatGeminiError(err, 'Gemini request failed.'));
      }
    }
  }

  throw new Error(formatGeminiError(lastErr, 'Gemini is temporarily busy. Please try again in a moment.'));
}

export async function generateTenglishPlaybook(params: {
  leadName: string;
  businessName: string;
  businessType: string;
  focusServices: ServiceFocus[];
  customNotes?: string;
  voiceName: VoiceOptionId;
}): Promise<PitchPlaybook> {
  const agentName = getAgentPersonaName(params.voiceName);
  const agentTeluguName = getAgentTeluguName(params.voiceName);

  const prompt = `Create a warm, polite, calm outbound phone pitch playbook for ${agentTeluguName} (${agentName}), a 25-year-old friendly Indian female from Warangal (like a polite customer-care representative, never pushy or over-excited) calling ${params.leadName || 'a business owner'} at "${params.businessName || 'their shop'}" (${params.businessType || 'local business'}).

Services to cover gently (one idea at a time, never reading long lists): ${params.focusServices.join(', ') || 'web_app, mobile_app, meta_ads'}.
Extra lead notes: ${params.customNotes || 'None provided.'}

CRITICAL VOICE, ACCENT & PLAIN-LANGUAGE RULES:
- Write EVERY spoken word — INCLUDING English loanwords AND the lead/business names — phonetically in **100% TELUGU UNICODE SCRIPT (తెలుగు లిపి)** (e.g., వెబ్‌డెవ్స్, గూగుల్, షాప్, వెబ్‌సైట్, మొబైల్ యాప్, ఇన్‌స్టాగ్రామ్, వాట్సాప్) so TTS stays 100% locked onto a natural Telugu accent with zero American or British pronunciation!
- Medium-slow, clear, polite Warangal/Telangana conversational tone (about 140–150 WPM). Smiling at the start, calm in the middle, warm and thankful at the end.
- Use human touches ("మ్మ్", "హా అండీ", "ఓకే అండీ") RARELY (only in 1 or 2 lines total, never fake or exaggerated).
- NEVER use heavy English technical jargon like "SEO optimization", "responsive UI", or "conversion funnel". Say plain everyday things like "గూగుల్ లో మీ షాప్ కనిపిస్తుంది" or "ఫోన్‌లో మీ వివరాలు క్లియర్‌గా ఓపెన్ అవుతాయి".
- Format any sample times naturally like "సాటర్డే మార్నింగ్ పదకొండు కి" and phone numbers in slow spoken groups like "నైన్ సెవెన్ జీరో జీరో, త్రీ నైన్ నైన్, నైన్ జీరో జీరో".
- Keep each line short (1–2 calm, clear sentences, no ellipses).`;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      openingHook: {
        type: Type.STRING,
        description: 'Lively 1–2 sentence youthful Hyderabadi Tenglish opener in native Telugu script + English words with natural filler like ఆహ్ or హే.',
      },
      webAppPitch: {
        type: Type.STRING,
        description: 'Flowing 1–2 sentence Web App pitch in native Telugu script + English words.',
      },
      mobileAppPitch: {
        type: Type.STRING,
        description: 'Flowing 1–2 sentence Mobile App pitch in native Telugu script + English words.',
      },
      metaAdsPitch: {
        type: Type.STRING,
        description: 'Flowing 1–2 sentence Meta Marketing / Ads pitch in native Telugu script + English words.',
      },
      closingAsk: {
        type: Type.STRING,
        description: 'Casual, friendly closing ask in native Telugu script + English words.',
      },
      objections: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            objection: { type: Type.STRING, description: 'Common lead objection.' },
            tenglishResponse: {
              type: Type.STRING,
              description: 'Natural, fast-flowing youthful Hyderabadi Tenglish reply in native Telugu script + English words starting with organic fillers like ఓహో / మ్మ్మ్ / హా / ఆహ్.',
            },
            trustTip: { type: Type.STRING, description: 'Short tactical note in English on why this builds trust.' },
          },
          required: ['objection', 'tenglishResponse', 'trustTip'],
        },
      },
      whatsappMessage: {
        type: Type.STRING,
        description: 'Friendly follow-up WhatsApp message in light Tenglish to send right after the call.',
      },
    },
    required: [
      'openingHook',
      'webAppPitch',
      'mobileAppPitch',
      'metaAdsPitch',
      'closingAsk',
      'objections',
      'whatsappMessage',
    ],
  };

  try {
    return await generateStructuredJson<PitchPlaybook>(prompt, schema);
  } catch (err) {
    if (!isBillingOrQuotaError(err) && !isTransientError(err)) {
      throw err;
    }
    return buildFallbackTenglishPlaybook(params);
  }
}

function buildFallbackTenglishPlaybook(params: {
  leadName: string;
  businessName: string;
  businessType: string;
  focusServices: ServiceFocus[];
  customNotes?: string;
  voiceName: VoiceOptionId;
}): PitchPlaybook {
  const agentName = getAgentPersonaName(params.voiceName);
  const agentTeluguName = getAgentTeluguName(params.voiceName);
  const lead = params.leadName || 'there';
  const biz = params.businessName || 'your business';

  return {
    openingHook: `హలో అండీ, నేను ${agentTeluguName}ని, వెబ్‌డెవ్స్ నుంచి మాట్లాడుతున్నా. మీ షాప్ గురించి చూశాను, మీతో ఒక నిమిషం మాట్లాడవచ్చా అండీ?`,
    webAppPitch:
      'ఇప్పుడు ఎవరైనా దగ్గర్లో షాప్ కావాలంటే ముందు గూగుల్ లో చూస్తారు కదా అండీ. గూగుల్ లో మీ షాప్ కనిపిస్తుంది, ఇంకా ఫోన్‌లో కస్టమర్స్ సులభంగా మీ వివరాలు చూసి డైరెక్ట్‌గా కాల్ చేయొచ్చు.',
    mobileAppPitch:
      'మీ రెగ్యులర్ కస్టమర్స్ కోసం ఒక సింపుల్ మొబైల్ యాప్ ఉంటే, మధ్యలో ఎవరి కమిషన్ లేకుండా డైరెక్ట్‌గా మీకే ఆర్డర్స్ వస్తాయి అండీ.',
    metaAdsPitch:
      'హా అండీ, మీ ఏరియా చుట్టుపక్కల ఉన్న కస్టమర్స్ ఫోన్‌లో ఇన్‌స్టాగ్రామ్ ఇంకా ఫేస్‌బుక్ ద్వారా మీ షాప్ కనిపించేలా సింపుల్ యాడ్స్ కూడా చేస్తాము.',
    closingAsk:
      'ఇప్పుడు ఇబ్బంది ఏమీ లేదు అండీ, ముందు వాట్సాప్ లో మా వర్క్ వివరాలు పంపిస్తాను. సాటర్డే మార్నింగ్ పదకొండు కి ఒకసారి మాట్లాడదామా అండీ?',
    objections: [
      {
        objection: 'We already have an agency or website',
        tenglishResponse:
          'హా అండీ, చాలా మంచిది. నేను జస్ట్ ఒక్కసారి మా పని వివరాలు వాట్సాప్ లో పంపిస్తాను, మీకు సమయం ఉన్నప్పుడు చూసి నచ్చితేనే చెప్పండి.',
        trustTip: 'Polite, calm validation with zero pushiness builds immediate trust.',
      },
      {
        objection: 'Busy right now / call later',
        tenglishResponse:
          'ఓకే అండీ, అర్థమైంది, నేను ఇబ్బంది పెట్టను. సాటర్డే మార్నింగ్ పదకొండు కి కాల్ చేస్తే మీకు కుదురుతుందా అండీ?',
        trustTip: 'Respects their time immediately and suggests a clear, friendly callback time.',
      },
      {
        objection: 'How much does it cost?',
        tenglishResponse:
          'మ్మ్ మీ షాప్ అవసరాన్ని బట్టి చిన్న ప్లాన్ నుంచే స్టార్ట్ అవుతుంది అండీ. నేను వాట్సాప్ లో క్లియర్‌గా వివరాలు పంపిస్తాను, చూశాక మాట్లాడుకోవచ్చు.',
        trustTip: 'Keeps pricing simple, transparent, and pressure-free without heavy jargon.',
      },
    ],
    whatsappMessage: `Namaskaram ${lead} garu! Nenu ${agentName}, WebDevs nundi maatladutunna. Google lo ${biz} kanipinchela simple website, mobile app & local Instagram ads gurinchi call chesanu. Mee convenience prakaram oka 5 mins matladudam—thank you andi!`,
  };
}

export async function synthesizeTenglishSpeech(params: {
  text: string;
  voiceName: VoiceOptionId;
}): Promise<{ audioBase64: string; mimeType: string }> {
  const ai = getGeminiClient();

  const stylePrompt =
    params.voiceName === 'Aoede'
      ? 'A warm, polite, friendly 25-year-old Indian female from Warangal speaking like a calm customer-care representative on a phone call. Natural Indian Telugu (te-IN) accent across both Telugu and English words — zero American or British accent. Medium-slow, clear speaking speed around 140 to 150 words per minute, slowing slightly for names, numbers, and times. Medium soft steady pitch with a gentle rise at the end of questions. Smiling at the start, calm in the middle, warm and thankful at the end — never robotic, never rushed, never over-excited.'
      : 'A warm, polite 26-year-old Indian female from Warangal speaking calmly and clearly on a phone call. Authentic native Telugu (te-IN) accent on every Telugu and English word — zero Western accent. Medium-slow pace around 140 to 150 words per minute, medium soft steady pitch with slight upward inflection on questions, calm and polite throughout — never pushy or overly excited.';

  const models = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];
  let lastErr: unknown;

  for (let i = 0; i < models.length; i++) {
    if (i > 0) await sleep(400);
    try {
      const response = await ai.models.generateContent({
        model: models[i],
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: params.text,
                speechMetadata: {
                  style: stylePrompt,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            languageCode: 'te-IN',
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: params.voiceName,
              },
            },
          },
        },
      });

      const inline = response.candidates?.[0]?.content?.parts?.[0]?.inlineData;
      if (!inline?.data) {
        throw new Error('Speech synthesis returned empty audio payload.');
      }

      return {
        audioBase64: inline.data,
        mimeType: inline.mimeType || 'audio/wav',
      };
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err)) {
        throw new Error(formatGeminiError(err, 'Speech synthesis failed.'));
      }
    }
  }

  throw new Error(formatGeminiError(lastErr, 'Speech synthesis is temporarily busy. Please retry.'));
}

function formatServicesLabel(services: ServiceFocus[]): string[] {
  const labels: Record<ServiceFocus, string> = {
    web_app: 'Web App',
    mobile_app: 'Mobile App',
    meta_ads: 'Meta Marketing & Ads',
  };
  return services.map((s) => labels[s] ?? s);
}

function buildFallbackCallSummary(call: CallRecord): CallSummary {
  const agentName = getAgentPersonaName(call.voiceName);
  const leadName = call.leadName || 'there';
  const businessName = call.businessName || 'your business';
  const servicesDiscussed = formatServicesLabel(
    call.focusServices.length > 0 ? call.focusServices : ['web_app', 'mobile_app', 'meta_ads']
  );
  const servicesText = servicesDiscussed.join(', ');

  const leadLines = call.transcript.filter((t) => t.speaker === 'lead');
  const agentLines = call.transcript.filter((t) => t.speaker === 'agent');
  const leadCombined = leadLines.map((t) => t.text.toLowerCase()).join(' ');

  const noConnectStatuses = new Set(['no-answer', 'busy', 'failed', 'canceled']);
  if (noConnectStatuses.has(call.status) || (agentLines.length === 0 && leadLines.length === 0)) {
    return {
      outcome: 'Voicemail / Short',
      summary: `Call to ${leadName} (${businessName}) ended with status "${call.status}" before a full conversation took place.`,
      servicesDiscussed: [],
      leadObjections: [],
      nextStep: 'Send a brief Hyderabadi Tenglish WhatsApp intro and retry calling during business hours.',
      whatsappFollowUp: `Hi ${leadName}! Nenu ${agentName} from WebDevs Hyderabad. Just tried calling regarding ${servicesText} for ${businessName}. Free unnapudu let me know, quick 5 mins chat cheddam!`,
    };
  }

  if (leadLines.length > 0) {
    let outcome: CallSummary['outcome'] = 'Follow-up Requested';
    const leadObjections: string[] = [];

    if (/\b(not interested|no thanks|don't need|vaddu|oddu|no need)\b/.test(leadCombined)) {
      outcome = 'Not Interested';
      leadObjections.push('Lead indicated they are not looking for these services right now.');
    } else if (/\b(busy|later|call back|tomorrow|evening|tarvata|meeting)\b/.test(leadCombined)) {
      outcome = 'Callback Scheduled';
      leadObjections.push('Lead was busy and asked to reconnect later.');
    } else if (/\b(interested|whatsapp|send|details|price|cost|quote|demo|sure|yes|cheppandi|pampandi)\b/.test(leadCombined)) {
      outcome = 'Interested';
    }

    if (/\b(price|cost|budget|expensive|rate)\b/.test(leadCombined)) {
      leadObjections.push('Asked about pricing / budget expectations.');
    }
    if (/\b(already have|agency|developer|website)\b/.test(leadCombined)) {
      leadObjections.push('Mentioned an existing website, app, or agency setup.');
    }

    return {
      outcome,
      summary: `${agentName} spoke with ${leadName} (${businessName}) for ${call.durationSec}s covering ${servicesText} (${leadLines.length} lead replies captured). Follow up promptly on WhatsApp with relevant WebDevs Hyderabad case studies.`,
      servicesDiscussed,
      leadObjections,
      nextStep:
        outcome === 'Callback Scheduled'
          ? 'Send WhatsApp portfolio link now and follow up at their preferred callback time.'
          : outcome === 'Not Interested'
            ? 'Send a polite thank-you note on WhatsApp and keep the lead warm for future campaigns.'
            : 'Send WebDevs Hyderabad portfolio samples & pricing overview on WhatsApp and book a 10-minute demo.',
      whatsappFollowUp: `Hi ${leadName}! Nenu ${agentName} from WebDevs Hyderabad—nice speaking with you just now about ${servicesText} for ${businessName}. Sending over a quick look at our recent Hyderabad client work; free unnapudu let's connect for 5 mins!`,
    };
  }

  // Connected inline TwiML pitch call (agent delivered Telugu pitch, no live two-way stream transcript)
  const shortCall = call.durationSec > 0 && call.durationSec < 12;
  return {
    outcome: shortCall ? 'Voicemail / Short' : 'Follow-up Requested',
    summary: shortCall
      ? `${agentName} connected briefly (${call.durationSec}s) with ${leadName} (${businessName}) while delivering the Hyderabadi Telugu intro pitch.`
      : `${agentName} delivered the personalized Hyderabadi Telugu pitch to ${leadName} (${businessName}) covering ${servicesText} (${call.durationSec}s).`,
    servicesDiscussed,
    leadObjections: [],
    nextStep: 'Follow up immediately on WhatsApp with WebDevs Hyderabad work samples while the intro is fresh.',
    whatsappFollowUp: `Hi ${leadName}! Nenu ${agentName} from WebDevs Hyderabad (Madhapur). Just called about boosting ${businessName} with ${servicesText}. Mana recent Hyderabad client works ikkada share chestunna—free unnapudu oka 5 mins matladudama?`,
  };
}

export async function generateCallSummary(call: CallRecord): Promise<CallSummary> {
  const transcriptText = call.transcript
    .filter((t) => t.speaker !== 'system')
    .map((t) => `${t.speaker === 'agent' ? 'WebDevs Agent' : call.leadName || 'Lead'}: ${t.text}`)
    .join('\n');

  if (!transcriptText.trim() || !process.env.GEMINI_API_KEY?.trim()) {
    return buildFallbackCallSummary(call);
  }

  const prompt = `Analyze this outbound sales call transcript from WebDevs Hyderabad calling ${call.leadName} (${call.businessName}, ${call.businessType}) and extract a crisp qualification summary plus a ready-to-send Hyderabadi Tenglish WhatsApp follow-up message.\n\nTRANSCRIPT:\n${transcriptText}`;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      outcome: {
        type: Type.STRING,
        description: 'One of: Interested, Follow-up Requested, Callback Scheduled, Not Interested, Voicemail / Short',
      },
      summary: {
        type: Type.STRING,
        description: 'Concise 2-sentence summary of the conversation.',
      },
      servicesDiscussed: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      leadObjections: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
      },
      nextStep: {
        type: Type.STRING,
        description: 'Concrete recommended next step for the WebDevs team.',
      },
      whatsappFollowUp: {
        type: Type.STRING,
        description: 'Warm, brief WhatsApp follow-up message in urban Hyderabadi Tenglish referencing what was discussed.',
      },
    },
    required: ['outcome', 'summary', 'servicesDiscussed', 'leadObjections', 'nextStep', 'whatsappFollowUp'],
  };

  try {
    return await Promise.race([
      generateStructuredJson<CallSummary>(prompt, schema),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Summary generation timed out')), 6000)
      ),
    ]);
  } catch {
    return buildFallbackCallSummary(call);
  }
}

function buildFallbackInlineTeluguPitch(params: {
  focusServices: ServiceFocus[];
  voiceName: VoiceOptionId;
}): string[] {
  const agentTeluguName = getAgentTeluguName(params.voiceName);
  const serviceParts: string[] = [];
  if (params.focusServices.includes('web_app')) serviceParts.push('గూగుల్ లో మీ షాప్ కనిపించేలా సింపుల్ వెబ్‌సైట్');
  if (params.focusServices.includes('mobile_app')) serviceParts.push('కస్టమర్స్ డైరెక్ట్‌గా ఆర్డర్ చేసే మొబైల్ యాప్');
  if (params.focusServices.includes('meta_ads')) serviceParts.push('మీ ఏరియా కస్టమర్స్ కి ఇన్‌స్టాగ్రామ్ యాడ్స్');
  const servicesPhrase =
    serviceParts.length > 0
      ? serviceParts[0]
      : 'గూగుల్ లో మీ షాప్ కనిపించేలా సింపుల్ వెబ్‌సైట్ ఇంకా ఇన్‌స్టాగ్రామ్ యాడ్స్';

  return [
    `హలో అండీ, నేను ${agentTeluguName}ని, వెబ్‌డెవ్స్ నుంచి మాట్లాడుతున్నా.`,
    `మీ షాప్ గురించి చూశాను అండీ, ${servicesPhrase} ద్వారా మీకు డైరెక్ట్ కస్టమర్స్ పెరిగేలా మేము హెల్ప్ చేస్తాము.`,
    'ఇప్పుడు ఇబ్బంది ఏమీ లేదు అండీ, ముందు వాట్సాప్ లో మా పని వివరాలు పంపిస్తాను.',
    'మీకు ఫ్రీ ఉన్నప్పుడు ఒకసారి మాట్లాడుకోవచ్చు, మాట్లాడినందుకు థ్యాంక్యూ అండీ.',
  ];
}

export async function generateInlinePhonePitch(params: {
  leadName: string;
  businessName: string;
  businessType: string;
  focusServices: ServiceFocus[];
  customNotes?: string;
  voiceName: VoiceOptionId;
}): Promise<string[]> {
  const agentTeluguName = getAgentTeluguName(params.voiceName);

  const serviceDescriptions: Record<ServiceFocus, string> = {
    web_app: 'గూగుల్ లో మీ షాప్ కనిపించేలా సింపుల్ వెబ్‌సైట్ ఇంకా ఫోన్‌లో సులభంగా ఓపెన్ అయ్యే పేజ్',
    mobile_app: 'మీ రెగ్యులర్ కస్టమర్స్ డైరెక్ట్‌గా ఆర్డర్ పెట్టుకునే సింపుల్ మొబైల్ యాప్',
    meta_ads: 'మీ ఏరియా కస్టమర్స్ కి ఇన్‌స్టాగ్రామ్ అండ్ ఫేస్‌బుక్ లో మీ షాప్ చూపించే యాడ్స్',
  };

  const selectedServicesText =
    params.focusServices.length > 0
      ? params.focusServices.map((s) => serviceDescriptions[s]).join('; ')
      : Object.values(serviceDescriptions).join('; ');

  const prompt = `Write a warm, polite, calm spoken phone intro from ${agentTeluguName}, a friendly 25-year-old Indian female from Warangal (like a polite customer-care girl, never pushy or over-excited), calling ${params.leadName || 'అండీ'} of "${params.businessName || 'మీ షాప్'}" (${params.businessType || 'లోకల్ బిజినెస్'}).

Services to mention gently (pick the main benefit simply, NEVER read a long list): ${selectedServicesText}.
Extra notes: ${params.customNotes || 'None.'}

CRITICAL VOICE, ACCENT & PLAIN-LANGUAGE RULES:
- Write EVERY SINGLE WORD — INCLUDING English loanwords AND the lead/business name — phonetically in **100% TELUGU UNICODE SCRIPT (తెలుగు లిపి)** (e.g., వెబ్‌డెవ్స్, గూగుల్, షాప్, వెబ్‌సైట్, మొబైల్ యాప్, ఇన్‌స్టాగ్రామ్, వాట్సాప్)! ZERO Latin A-Z letters anywhere in the output so Google Telugu TTS stays 100% locked onto a genuine native Telugu accent!
- Calm, polite, friendly Warangal customer-care tone (medium-slow 140–150 WPM feel): smiling at the start, calm in the middle, warm and thankful at the end.
- NEVER use heavy English jargon like "SEO optimization" or "responsive UI". Say plain everyday phrases like "గూగుల్ లో మీ షాప్ కనిపిస్తుంది".
- NEVER sound pushy, shout, or exaggerate fillers. At most ONE subtle human touch ("హా అండీ") across all 4 sentences.
- IMPORTANT LENGTH LIMIT: Return 4 short, clear sentences, each under 100 characters ending cleanly with ".", "?", or "!".
- Strictly plain Telugu script spoken text: NO A-Z English letters, NO emojis, NO markdown, NO bullets, NO ellipses ("..."), NO quotes, NO brackets.`;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      segments: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: '4 short, fast-flowing spoken sentences in 100% Telugu Unicode script (even English loanwords & names written phonetically in Telugu script, each under 100 chars).',
      },
    },
    required: ['segments'],
  };

  try {
    // Cap Gemini pitch crafting at 5.5s so dialing never stalls or triggers proxy HTML timeouts
    const parsed = await Promise.race([
      generateStructuredJson<{ segments?: string[] }>(prompt, schema),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Pitch generation timed out')), 5500)
      ),
    ]);
    const segments = (parsed.segments ?? [])
      .map((s) =>
        s
          .replace(/\.{2,}/g, '.')
          .replace(/[\u2014\u2013]/g, ', ')
          .replace(/[*_`#[\](){}"]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter(Boolean);
    if (segments.length > 0) {
      return segments;
    }
  } catch {
    // Gracefully fall back to the built-in 100% Telugu-script Hyderabadi pitch
  }

  return buildFallbackInlineTeluguPitch({
    focusServices: params.focusServices,
    voiceName: params.voiceName,
  });
}
