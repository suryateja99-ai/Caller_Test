import type { VoiceOptionId } from '../types';

export interface VoiceOptionMeta {
  id: VoiceOptionId;
  agentName: string;
  teluguName: string;
  shortLabel: string;
  tone: string;
}

export const PRIMARY_VOICE_OPTIONS: VoiceOptionMeta[] = [
  {
    id: 'Aoede',
    agentName: 'Ananya',
    teluguName: 'అనన్య',
    shortLabel: 'Ananya · Warm & Calm',
    tone: 'Polite Warangal tone (24–28), medium-slow & steady',
  },
  {
    id: 'Leda',
    agentName: 'Kavya',
    teluguName: 'కావ్య',
    shortLabel: 'Kavya · Soft & Gentle',
    tone: 'Soft medium pitch, gentle & attentive listener',
  },
  {
    id: 'Zephyr',
    agentName: 'Divya',
    teluguName: 'దివ్య',
    shortLabel: 'Divya · Clear & Friendly',
    tone: 'Clear, smiling & patient customer-care tone',
  },
];

export function getVoiceAgentName(voiceName: VoiceOptionId): string {
  switch (voiceName) {
    case 'Leda':
      return 'Kavya';
    case 'Zephyr':
      return 'Divya';
    case 'Kore':
      return 'Meera';
    case 'Aoede':
    default:
      return 'Ananya';
  }
}

export function getVoiceTeluguName(voiceName: VoiceOptionId): string {
  switch (voiceName) {
    case 'Leda':
      return 'కావ్య';
    case 'Zephyr':
      return 'దివ్య';
    case 'Kore':
      return 'మీరా';
    case 'Aoede':
    default:
      return 'అనన్య';
  }
}
