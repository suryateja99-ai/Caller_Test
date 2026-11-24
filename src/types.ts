export type ServiceFocus = 'web_app' | 'mobile_app' | 'meta_ads';

export type VoiceOptionId = 'Leda' | 'Aoede' | 'Zephyr' | 'Kore';

export type CallStatus =
  | 'queued'
  | 'initiated'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'no-answer'
  | 'failed'
  | 'canceled';

export type CallChannel = 'twilio' | 'rehearsal';

export type LeadStage = 'New' | 'Contacted' | 'Interested' | 'Follow-up' | 'Not Interested';

export interface Lead {
  id: string;
  name: string;
  phone: string;
  businessName: string;
  businessType: string;
  location: string;
  focusServices: ServiceFocus[];
  notes: string;
  stage: LeadStage;
  createdAt: string;
  lastCalledAt?: string;
}

export interface TranscriptLine {
  id: string;
  speaker: 'agent' | 'lead' | 'system';
  text: string;
  timestamp: string;
}

export interface CallSummary {
  outcome: 'Interested' | 'Follow-up Requested' | 'Callback Scheduled' | 'Not Interested' | 'Voicemail / Short';
  summary: string;
  servicesDiscussed: string[];
  leadObjections: string[];
  nextStep: string;
  whatsappFollowUp: string;
}

export interface CallRecord {
  id: string;
  callSid?: string;
  leadId?: string;
  leadName: string;
  businessName: string;
  businessType: string;
  toNumber: string;
  fromNumber: string;
  voiceName: VoiceOptionId;
  focusServices: ServiceFocus[];
  customNotes: string;
  channel: CallChannel;
  callMode?: 'live-stream' | 'inline-twiml';
  status: CallStatus;
  startedAt: string;
  endedAt?: string;
  durationSec: number;
  transcript: TranscriptLine[];
  summary?: CallSummary;
  errorMessage?: string;
}

export interface ObjectionReply {
  objection: string;
  tenglishResponse: string;
  trustTip: string;
}

export interface PitchPlaybook {
  openingHook: string;
  webAppPitch: string;
  mobileAppPitch: string;
  metaAdsPitch: string;
  closingAsk: string;
  objections: ObjectionReply[];
  whatsappMessage: string;
}

export interface ServerConfigStatus {
  twilioConfigured: boolean;
  twilioFromNumberMasked: string | null;
  geminiConfigured: boolean;
  publicWebhookBaseUrl: string;
  hasPublicWebhookUrl: boolean;
  twilioWebhookReachable: boolean;
  twilioCallMode: 'live-stream' | 'inline-twiml';
}
