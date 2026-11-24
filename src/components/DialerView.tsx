import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Mic,
  PhoneCall,
  PhoneOff,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import type {
  CallRecord,
  Lead,
  ServerConfigStatus,
  ServiceFocus,
  VoiceOptionId,
} from '../types';
import { apiJson } from '../lib/api';
import { getVoiceAgentName, PRIMARY_VOICE_OPTIONS } from '../lib/voices';
import { AgentAvatar } from './AgentAvatar';

export interface CallDraft {
  leadId?: string;
  toNumber: string;
  leadName: string;
  businessName: string;
  businessType: string;
  focusServices: ServiceFocus[];
  voiceName: VoiceOptionId;
  customNotes: string;
}

interface DialerViewProps {
  draft: CallDraft;
  onDraftChange: (patch: Partial<CallDraft>) => void;
  leads: Lead[];
  activeCall: CallRecord | null;
  recentCalls: CallRecord[];
  configStatus: ServerConfigStatus | null;
  onSelectCall: (call: CallRecord) => void;
  onCallStarted: (call: CallRecord) => void;
  onOpenVoiceStudio: () => void;
}

const SERVICE_OPTIONS: { id: ServiceFocus; label: string; desc: string }[] = [
  { id: 'web_app', label: 'Web Apps', desc: 'Websites, portals & dashboards' },
  { id: 'mobile_app', label: 'Mobile Apps', desc: 'Android & iOS customer apps' },
  { id: 'meta_ads', label: 'Meta Ads', desc: 'Instagram & Facebook lead gen' },
];

const VOICE_OPTIONS = PRIMARY_VOICE_OPTIONS;

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getStatusMeta(status: CallRecord['status']): { label: string; colorClass: string; isLive: boolean } {
  switch (status) {
    case 'in-progress':
      return { label: 'Connected · Live', colorClass: 'text-emerald-700', isLive: true };
    case 'ringing':
      return { label: 'Ringing', colorClass: 'text-amber-700', isLive: true };
    case 'queued':
    case 'initiated':
      return { label: 'Dialing', colorClass: 'text-amber-700', isLive: true };
    case 'completed':
      return { label: 'Completed', colorClass: 'text-slate-700', isLive: false };
    case 'busy':
      return { label: 'Line Busy', colorClass: 'text-amber-700', isLive: false };
    case 'no-answer':
      return { label: 'No Answer', colorClass: 'text-slate-600', isLive: false };
    case 'failed':
    case 'canceled':
      return { label: 'Failed', colorClass: 'text-red-700', isLive: false };
    default:
      return { label: status, colorClass: 'text-slate-600', isLive: false };
  }
}

export function DialerView({
  draft,
  onDraftChange,
  leads,
  activeCall,
  recentCalls,
  configStatus,
  onSelectCall,
  onCallStarted,
  onOpenVoiceStudio,
}: DialerViewProps) {
  const [submitting, setSubmitting] = useState(false);
  const [hangingUp, setHangingUp] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [liveSeconds, setLiveSeconds] = useState(0);

  const isCallLive = Boolean(
    activeCall && ['queued', 'initiated', 'ringing', 'in-progress'].includes(activeCall.status)
  );

  useEffect(() => {
    if (!activeCall || !isCallLive) {
      setLiveSeconds(activeCall?.durationSec ?? 0);
      return;
    }
    const updateTick = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - new Date(activeCall.startedAt).getTime()) / 1000));
      setLiveSeconds(elapsed);
    };
    updateTick();
    const timer = window.setInterval(updateTick, 1000);
    return () => window.clearInterval(timer);
  }, [activeCall, isCallLive]);

  const toggleService = (serviceId: ServiceFocus) => {
    const exists = draft.focusServices.includes(serviceId);
    if (exists && draft.focusServices.length === 1) return;
    const next = exists
      ? draft.focusServices.filter((s) => s !== serviceId)
      : [...draft.focusServices, serviceId];
    onDraftChange({ focusServices: next });
  };

  const applyLead = (leadId: string) => {
    if (!leadId) {
      onDraftChange({ leadId: undefined });
      return;
    }
    const lead = leads.find((l) => l.id === leadId);
    if (!lead) return;
    onDraftChange({
      leadId: lead.id,
      toNumber: lead.phone,
      leadName: lead.name,
      businessName: lead.businessName,
      businessType: lead.businessType,
      focusServices: lead.focusServices,
      customNotes: lead.notes,
    });
    setError(null);
  };

  const handleDial = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNeedsReload(false);
    const cleanedPhone = draft.toNumber.replace(/[\s\-()]/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(cleanedPhone)) {
      setError('Enter a valid E.164 phone number starting with + and country code (e.g., +919848011223).');
      return;
    }

    setSubmitting(true);
    try {
      const result = await apiJson<{ call?: CallRecord; error?: string }>('/api/calls/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...draft,
          toNumber: cleanedPhone,
        }),
      });
      if (!result.ok) {
        if (result.data?.call) onCallStarted(result.data.call);
        if (result.needsReload) setNeedsReload(true);
        throw new Error(result.error || 'Could not initiate Twilio call.');
      }
      if (result.data?.call) {
        onCallStarted(result.data.call);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start call.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleHangup = async () => {
    if (!activeCall) return;
    setHangingUp(true);
    setError(null);
    try {
      const result = await apiJson<{ call?: CallRecord; error?: string }>(
        `/api/calls/${encodeURIComponent(activeCall.id)}/hangup`,
        { method: 'POST' }
      );
      if (!result.ok) throw new Error(result.error || 'Could not hang up call.');
      if (result.data?.call) onSelectCall(result.data.call);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to end call.');
    } finally {
      setHangingUp(false);
    }
  };

  const handleRegenerateSummary = async () => {
    if (!activeCall) return;
    setSummarizing(true);
    try {
      const result = await apiJson<{ call?: CallRecord; error?: string }>(
        `/api/calls/${encodeURIComponent(activeCall.id)}/summarize`,
        { method: 'POST' }
      );
      if (result.ok && result.data?.call) {
        onSelectCall(result.data.call);
      }
    } finally {
      setSummarizing(false);
    }
  };

  const handleCopyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      window.setTimeout(() => setCopiedId(null), 1800);
    } catch {
      // clipboard unavailable
    }
  };

  const activeAgentName = getVoiceAgentName(draft.voiceName);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left: Outbound Dialer Composer */}
      <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex items-start justify-between gap-4 pb-5 border-b border-slate-100">
          <div>
            <h1 className="text-lg font-semibold text-slate-900 tracking-tight">
              Outbound AI Pitch Dialer
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Dial any lead via Twilio using {activeAgentName} in modern urban Hyderabadi Tenglish.
            </p>
          </div>
          <AgentAvatar name={activeAgentName} size="md" />
        </div>

        {configStatus && !configStatus.twilioConfigured && (
          <div className="mt-5 p-3.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 leading-relaxed">
            <div className="font-semibold text-amber-950 flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              Twilio secrets required for live phone calls
            </div>
            <p className="mt-1">
              Add <code className="font-mono text-[11px]">TWILIO_ACCOUNT_SID</code>,{' '}
              <code className="font-mono text-[11px]">TWILIO_AUTH_TOKEN</code>, and{' '}
              <code className="font-mono text-[11px]">TWILIO_PHONE_NUMBER</code> in{' '}
              <span className="font-medium">Settings &gt; Secrets</span>. You can test the live Hyderabadi
              Tenglish voice right now in the Voice Studio.
            </p>
          </div>
        )}

        {configStatus && configStatus.twilioConfigured && !configStatus.twilioWebhookReachable && (
          <div className="mt-5 p-3.5 rounded-lg bg-amber-50/70 border border-amber-200/80 text-xs text-slate-700 leading-relaxed space-y-2">
            <div className="font-semibold text-slate-900">
              Why phone calls sound one-way in Dev Preview
            </div>
            <p>
              Private dev preview blocks Twilio&apos;s inbound audio stream, so phone calls here play a one-way TTS message that cannot hear you talk. <span className="font-medium text-slate-900">Publish this app</span> (or set a public <code className="font-mono text-[11px]">WEBHOOK_BASE_URL</code>) to switch real phone calls to <span className="font-medium text-slate-900">full two-way humanized Gemini Live</span> (natural breaths, laughs, and instant stop when you speak).
            </p>
            <div>
              <button
                type="button"
                onClick={onOpenVoiceStudio}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium transition-colors whitespace-nowrap cursor-pointer"
              >
                <Mic className="w-3.5 h-3.5" />
                Hear True Two-Way Human Voice in Browser
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleDial} className="mt-5 space-y-4">
          {/* Quick-pick existing lead */}
          <div>
            <label htmlFor="quick-lead" className="block text-xs font-medium text-slate-700 mb-1.5">
              Load from Lead Queue
            </label>
            <select
              id="quick-lead"
              value={draft.leadId || ''}
              onChange={(e) => applyLead(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
            >
              <option value="">Custom number / manual entry</option>
              {leads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.name} — {lead.businessName} ({lead.phone})
                </option>
              ))}
            </select>
          </div>

          {/* Destination Phone */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="to-number" className="text-xs font-medium text-slate-700">
                Destination Phone Number (E.164)
              </label>
              <div className="flex items-center gap-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    if (!draft.toNumber.startsWith('+91')) {
                      onDraftChange({ toNumber: '+91' + draft.toNumber.replace(/^\+?\d{0,2}/, '') });
                    }
                  }}
                  className="text-teal-700 hover:text-teal-900 font-medium px-1.5 py-0.5 rounded hover:bg-teal-50 transition-colors whitespace-nowrap"
                >
                  +91 IN
                </button>
                <span className="text-slate-300" aria-hidden="true">/</span>
                <button
                  type="button"
                  onClick={() => {
                    if (!draft.toNumber.startsWith('+1')) {
                      onDraftChange({ toNumber: '+1' + draft.toNumber.replace(/^\+?\d{0,2}/, '') });
                    }
                  }}
                  className="text-teal-700 hover:text-teal-900 font-medium px-1.5 py-0.5 rounded hover:bg-teal-50 transition-colors whitespace-nowrap"
                >
                  +1 US
                </button>
              </div>
            </div>
            <input
              id="to-number"
              type="tel"
              required
              placeholder="+919848011223"
              value={draft.toNumber}
              onChange={(e) => onDraftChange({ toNumber: e.target.value })}
              className="w-full h-11 px-3.5 rounded-lg border border-slate-200 bg-white font-mono tabular-nums text-base text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
            />
          </div>

          {/* Lead & Business Context */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="lead-name" className="block text-xs font-medium text-slate-700 mb-1.5">
                Lead Name
              </label>
              <input
                id="lead-name"
                type="text"
                placeholder="Karthik Reddy"
                value={draft.leadName}
                onChange={(e) => onDraftChange({ leadName: e.target.value })}
                className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
              />
            </div>
            <div>
              <label htmlFor="business-name" className="block text-xs font-medium text-slate-700 mb-1.5">
                Business Name
              </label>
              <input
                id="business-name"
                type="text"
                placeholder="Deccan Spice Kitchen"
                value={draft.businessName}
                onChange={(e) => onDraftChange({ businessName: e.target.value })}
                className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
              />
            </div>
          </div>

          <div>
            <label htmlFor="business-type" className="block text-xs font-medium text-slate-700 mb-1.5">
              Business Category
            </label>
            <input
              id="business-type"
              type="text"
              placeholder="Cloud Kitchen, Dental Clinic, Boutique, Real Estate..."
              value={draft.businessType}
              onChange={(e) => onDraftChange({ businessType: e.target.value })}
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700"
            />
          </div>

          {/* WebDevs Services to Pitch */}
          <div>
            <span className="block text-xs font-medium text-slate-700 mb-1.5">
              WebDevs Services to Pitch
            </span>
            <div className="grid grid-cols-3 gap-2">
              {SERVICE_OPTIONS.map((svc) => {
                const selected = draft.focusServices.includes(svc.id);
                return (
                  <button
                    key={svc.id}
                    type="button"
                    onClick={() => toggleService(svc.id)}
                    aria-pressed={selected}
                    className={`px-3 py-2 rounded-lg border text-left transition-colors ${
                      selected
                        ? 'border-teal-700 bg-teal-50/70 text-teal-950'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <div className="text-xs font-semibold whitespace-nowrap">{svc.label}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5 line-clamp-1">{svc.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Young Woman Hyderabadi Voice Selection */}
          <div>
            <span className="block text-xs font-medium text-slate-700 mb-1.5">
              Voice Persona (Young Woman · Hyderabadi Tenglish)
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {VOICE_OPTIONS.map((v) => {
                const selected = draft.voiceName === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => onDraftChange({ voiceName: v.id })}
                    aria-pressed={selected}
                    className={`px-3 py-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                      selected
                        ? 'border-teal-700 bg-teal-50/70 text-teal-950'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                    }`}
                  >
                    <div className="text-xs font-semibold whitespace-nowrap">
                      {v.agentName} ({v.id})
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">{v.tone}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Lead Notes */}
          <div>
            <label htmlFor="custom-notes" className="block text-xs font-medium text-slate-700 mb-1.5">
              Pitch Context &amp; Notes (Optional)
            </label>
            <textarea
              id="custom-notes"
              rows={2}
              placeholder="e.g., Already active on Instagram, needs direct booking web app & weekend Meta lead ads..."
              value={draft.customNotes}
              onChange={(e) => onDraftChange({ customNotes: e.target.value })}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-teal-600/20 focus:border-teal-700 resize-none"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800 leading-relaxed flex flex-wrap items-center justify-between gap-2.5"
            >
              <span className="flex-1 min-w-[200px]">{error}</span>
              {needsReload && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-red-700 hover:bg-red-800 text-white text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Refresh Session
                </button>
              )}
            </div>
          )}

          <div className="pt-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5">
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 inline-flex items-center justify-center gap-2 h-11 px-5 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:bg-slate-300 text-white text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              <PhoneCall className="w-4 h-4 shrink-0" />
              {submitting ? 'Placing Twilio Call...' : 'Place Twilio Pitch Call'}
            </button>

            <button
              type="button"
              onClick={onOpenVoiceStudio}
              className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Mic className="w-4 h-4 shrink-0" />
              Rehearse in Browser
            </button>
          </div>
        </form>
      </section>

      {/* Right: Live Call Monitor & Transcript */}
      <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl flex flex-col min-h-[600px]">
        {activeCall ? (
          <>
            {/* Active Call Header */}
            <div className="p-6 border-b border-slate-100 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3.5 min-w-0">
                <AgentAvatar name={getVoiceAgentName(activeCall.voiceName)} size="md" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-semibold text-slate-900 truncate">
                      {activeCall.leadName} · {activeCall.businessName}
                    </h2>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-slate-500 mt-1 flex-wrap">
                    <span className="font-mono tabular-nums text-slate-700">{activeCall.toNumber}</span>
                    <span aria-hidden="true">·</span>
                    <span>{activeCall.channel === 'twilio' ? 'Twilio Voice Stream' : 'Browser Rehearsal'}</span>
                    <span aria-hidden="true">·</span>
                    <span className={`font-medium inline-flex items-center gap-1.5 ${getStatusMeta(activeCall.status).colorClass}`}>
                      {getStatusMeta(activeCall.status).isLive && (
                        <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse" aria-hidden="true" />
                      )}
                      {getStatusMeta(activeCall.status).label}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <div className="text-right">
                  <div className="text-[11px] text-slate-500">Duration</div>
                  <div className="font-mono tabular-nums text-sm font-semibold text-slate-900">
                    {formatDuration(isCallLive ? liveSeconds : activeCall.durationSec)}
                  </div>
                </div>
                {isCallLive && activeCall.channel === 'twilio' && (
                  <button
                    type="button"
                    onClick={handleHangup}
                    disabled={hangingUp}
                    className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <PhoneOff className="w-3.5 h-3.5" />
                    {hangingUp ? 'Ending...' : 'End Call'}
                  </button>
                )}
              </div>
            </div>

            {/* Live Transcript Feed */}
            <div className="flex-1 p-6 overflow-y-auto max-h-[380px] space-y-4">
              {activeCall.transcript.length === 0 ? (
                <p className="text-sm text-slate-500">Waiting for audio connection...</p>
              ) : (
                activeCall.transcript.map((entry) => {
                  if (entry.speaker === 'system') {
                    return (
                      <div key={entry.id} className="text-xs text-slate-500 py-1 border-b border-slate-100">
                        <span className="font-mono tabular-nums mr-2">
                          {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        {entry.text}
                      </div>
                    );
                  }
                  const isAgent = entry.speaker === 'agent';
                  return (
                    <div
                      key={entry.id}
                      className={`flex flex-col ${isAgent ? 'items-start' : 'items-end'}`}
                    >
                      <div className="flex items-center gap-2 text-[11px] text-slate-500 mb-1">
                        <span className="font-medium text-slate-700">
                          {isAgent ? `${getVoiceAgentName(activeCall.voiceName)} (WebDevs)` : activeCall.leadName}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                      </div>
                      <div
                        className={`max-w-[85%] px-4 py-2.5 rounded-xl text-sm leading-relaxed ${
                          isAgent
                            ? 'bg-slate-100 text-slate-900'
                            : 'bg-teal-700 text-white'
                        }`}
                      >
                        {entry.text}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Post-Call AI Summary & WhatsApp Follow-Up */}
            <div className="p-6 border-t border-slate-100 bg-slate-50/70 rounded-b-xl">
              {activeCall.summary ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-xs text-slate-500">
                      <span className="font-semibold text-slate-900">AI Post-Call Qualification</span>
                      <span className="mx-1.5" aria-hidden="true">·</span>
                      <span className="font-medium text-teal-800">{activeCall.summary.outcome}</span>
                    </div>
                    <button
                      type="button"
                      onClick={handleRegenerateSummary}
                      disabled={summarizing}
                      className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap cursor-pointer"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${summarizing ? 'animate-spin' : ''}`} />
                      Refresh Summary
                    </button>
                  </div>
                  <p className="text-sm text-slate-700 leading-relaxed">{activeCall.summary.summary}</p>
                  <div className="text-xs text-slate-600">
                    <span className="font-medium text-slate-900">Next Step: </span>
                    {activeCall.summary.nextStep}
                  </div>
                  <div className="pt-2 border-t border-slate-200/80">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium text-slate-700">
                        Ready-to-Send Tenglish WhatsApp Follow-Up
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyText('wa', activeCall.summary!.whatsappFollowUp)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-900 whitespace-nowrap cursor-pointer"
                      >
                        {copiedId === 'wa' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                        {copiedId === 'wa' ? 'Copied' : 'Copy Message'}
                      </button>
                    </div>
                    <p className="text-xs text-slate-700 bg-white border border-slate-200 rounded-lg p-3 leading-relaxed">
                      {activeCall.summary.whatsappFollowUp}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-4 text-xs text-slate-500">
                  <span>
                    {isCallLive
                      ? 'Live call transcript updates in real time. Post-call qualification & WhatsApp follow-up will appear when the call ends.'
                      : 'Call ended. Generate an AI qualification summary and Tenglish WhatsApp follow-up.'}
                  </span>
                  {!isCallLive && (
                    <button
                      type="button"
                      onClick={handleRegenerateSummary}
                      disabled={summarizing}
                      className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-slate-800 font-medium whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {summarizing ? 'Summarizing...' : 'Generate Summary'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col justify-between p-8">
            <div className="max-w-lg mx-auto my-auto text-center space-y-4">
              <div className="flex justify-center">
                <AgentAvatar name={activeAgentName} size="lg" />
              </div>
              <h2 className="text-lg font-semibold text-slate-900">
                Ready to call with {activeAgentName} from WebDevs
              </h2>
              <p className="text-sm text-slate-500 leading-relaxed">
                Enter any lead&apos;s phone number on the left to initiate a real-time Twilio AI voice call
                in warm urban Hyderabadi Tenglish, or rehearse live right in your browser first.
              </p>
              <div className="pt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span>Web Apps</span>
                <span aria-hidden="true">·</span>
                <span>Mobile Apps</span>
                <span aria-hidden="true">·</span>
                <span>Meta Marketing &amp; Ads</span>
                <span aria-hidden="true">·</span>
                <span>Real-time Interruptible Voice</span>
              </div>
            </div>

            {recentCalls.length > 0 && (
              <div className="pt-6 mt-6 border-t border-slate-100">
                <div className="text-xs font-medium text-slate-500 mb-2.5">Recent Sessions</div>
                <div className="divide-y divide-slate-100">
                  {recentCalls.slice(0, 3).map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => onSelectCall(c)}
                      className="w-full py-2.5 flex items-center justify-between gap-4 text-left hover:bg-slate-50 px-2 rounded-lg transition-colors cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-900 truncate">
                          {c.leadName} · {c.businessName}
                        </div>
                        <div className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                          {c.toNumber}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className={`text-xs font-medium ${getStatusMeta(c.status).colorClass}`}>
                          {getStatusMeta(c.status).label}
                        </div>
                        <div className="text-xs text-slate-400 font-mono tabular-nums">
                          {formatDuration(c.durationSec)}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
