import fs from 'fs';
import path from 'path';
import type { CallRecord, CallSummary, Lead, TranscriptLine } from '../types.ts';

interface StoreState {
  leads: Lead[];
  calls: CallRecord[];
}

const DATA_DIR = path.resolve(process.cwd(), '.data');
const STORE_PATH = path.resolve(DATA_DIR, 'store.json');

const SEED_LEADS: Lead[] = [
  {
    id: 'lead-hyd-01',
    name: 'Karthik Reddy',
    phone: '+919848011223',
    businessName: 'Deccan Spice Kitchen',
    businessType: 'Cloud Kitchen & Biryani Delivery',
    location: 'Madhapur, Hyderabad',
    focusServices: ['mobile_app', 'meta_ads'],
    notes: 'Currently paying high aggregator commissions; looking to boost direct weekend orders around HITEC City.',
    stage: 'New',
    createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
  },
  {
    id: 'lead-hyd-02',
    name: 'Dr. Sneha Rao',
    phone: '+919000544321',
    businessName: 'Aura Dental & Aligners',
    businessType: 'Dental & Cosmetic Clinic',
    location: 'Jubilee Hills, Hyderabad',
    focusServices: ['web_app', 'meta_ads'],
    notes: 'Needs online slot booking web app and Instagram lead campaigns for invisalign consultations.',
    stage: 'Follow-up',
    createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
  },
  {
    id: 'lead-hyd-03',
    name: 'Harsha Vardhan',
    phone: '+919949233810',
    businessName: 'Kora Handloom Studio',
    businessType: 'Boutique Ethnic Wear Brand',
    location: 'Banjara Hills, Hyderabad',
    focusServices: ['web_app', 'mobile_app', 'meta_ads'],
    notes: 'Strong Instagram following; wants a fast D2C storefront with WhatsApp checkout and festival Meta ad funnels.',
    stage: 'New',
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: 'lead-hyd-04',
    name: 'Prashanth Goud',
    phone: '+919701455908',
    businessName: 'Skyline PropTech Advisory',
    businessType: 'Real Estate & Gated Communities',
    location: 'Kokapet, Hyderabad',
    focusServices: ['web_app', 'meta_ads'],
    notes: 'Launching new villa plots near Neopolis; needs high-intent Meta lead funnels and interactive project portal.',
    stage: 'New',
    createdAt: new Date(Date.now() - 3600000 * 8).toISOString(),
  },
];

let state: StoreState = {
  leads: [...SEED_LEADS],
  calls: [],
};

function ensureStoreLoaded(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!STORE_PATH.startsWith(DATA_DIR + path.sep)) {
      throw new Error('Invalid store path');
    }
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreState>;
      state = {
        leads: Array.isArray(parsed.leads) && parsed.leads.length > 0 ? parsed.leads : [...SEED_LEADS],
        calls: Array.isArray(parsed.calls) ? parsed.calls : [],
      };
    } else {
      persistStore();
    }
  } catch (err) {
    console.warn('[Store] Starting with fresh in-memory seed data:', err instanceof Error ? err.message : err);
  }
}

function persistStore(): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!STORE_PATH.startsWith(DATA_DIR + path.sep)) {
      return;
    }
    const tmpPath = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpPath, STORE_PATH);
  } catch (err) {
    console.warn('[Store] Persist skipped:', err instanceof Error ? err.message : err);
  }
}

ensureStoreLoaded();

export const store = {
  getLeads(): Lead[] {
    return state.leads;
  },

  getLead(id: string): Lead | undefined {
    return state.leads.find((l) => l.id === id);
  },

  addLead(lead: Lead): Lead {
    state.leads = [lead, ...state.leads];
    persistStore();
    return lead;
  },

  updateLead(id: string, patch: Partial<Lead>): Lead | undefined {
    const idx = state.leads.findIndex((l) => l.id === id);
    if (idx === -1) return undefined;
    state.leads[idx] = { ...state.leads[idx], ...patch, id };
    persistStore();
    return state.leads[idx];
  },

  deleteLead(id: string): boolean {
    const prevLen = state.leads.length;
    state.leads = state.leads.filter((l) => l.id !== id);
    if (state.leads.length !== prevLen) {
      persistStore();
      return true;
    }
    return false;
  },

  getCalls(): CallRecord[] {
    return state.calls;
  },

  getCall(id: string): CallRecord | undefined {
    return state.calls.find((c) => c.id === id);
  },

  getCallBySid(callSid: string): CallRecord | undefined {
    return state.calls.find((c) => c.callSid === callSid);
  },

  addCall(call: CallRecord): CallRecord {
    state.calls = [call, ...state.calls];
    persistStore();
    return call;
  },

  updateCall(id: string, patch: Partial<CallRecord>): CallRecord | undefined {
    const idx = state.calls.findIndex((c) => c.id === id);
    if (idx === -1) return undefined;
    state.calls[idx] = { ...state.calls[idx], ...patch, id };
    persistStore();
    return state.calls[idx];
  },

  appendTranscript(callId: string, line: TranscriptLine): CallRecord | undefined {
    const call = state.calls.find((c) => c.id === callId);
    if (!call) return undefined;

    // Merge consecutive fragments from same speaker within 4 seconds for clean readable bubbles
    const last = call.transcript[call.transcript.length - 1];
    if (
      last &&
      last.speaker === line.speaker &&
      line.speaker !== 'system' &&
      Date.now() - new Date(last.timestamp).getTime() < 4500 &&
      last.text.length < 340
    ) {
      const separator = last.text.endsWith(' ') || line.text.startsWith(' ') ? '' : ' ';
      last.text = `${last.text}${separator}${line.text}`.replace(/\s+/g, ' ').trim();
      last.timestamp = line.timestamp;
    } else {
      call.transcript.push(line);
    }
    persistStore();
    return call;
  },

  setCallSummary(callId: string, summary: CallSummary): CallRecord | undefined {
    return this.updateCall(callId, { summary });
  },
};
