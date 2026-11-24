import { useMemo, useState } from 'react';
import { Check, Copy, RefreshCw, Search } from 'lucide-react';
import type { CallRecord } from '../types';
import { apiJson } from '../lib/api';
import { getVoiceAgentName } from '../lib/voices';

interface CallLogsViewProps {
  calls: CallRecord[];
  onCallUpdated: (call: CallRecord) => void;
  onStartNewCall: () => void;
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function CallLogsView({ calls, onCallUpdated, onStartNewCall }: CallLogsViewProps) {
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState<'all' | 'twilio' | 'rehearsal'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(calls[0]?.id ?? null);
  const [summarizing, setSummarizing] = useState(false);
  const [copied, setCopied] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return calls.filter((c) => {
      if (channelFilter !== 'all' && c.channel !== channelFilter) return false;
      if (!q) return true;
      return (
        c.leadName.toLowerCase().includes(q) ||
        c.businessName.toLowerCase().includes(q) ||
        c.toNumber.toLowerCase().includes(q)
      );
    });
  }, [calls, search, channelFilter]);

  const selectedCall = useMemo(() => {
    return calls.find((c) => c.id === selectedId) ?? filtered[0] ?? null;
  }, [calls, filtered, selectedId]);

  const handleSummarize = async (call: CallRecord) => {
    setSummarizing(true);
    try {
      const result = await apiJson<{ call?: CallRecord }>(
        `/api/calls/${encodeURIComponent(call.id)}/summarize`,
        { method: 'POST' }
      );
      if (result.ok && result.data?.call) {
        onCallUpdated(result.data.call);
      }
    } finally {
      setSummarizing(false);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900 tracking-tight">Call Logs &amp; Transcripts</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Review Twilio outbound pitches, rehearsal sessions, Tenglish transcripts, and AI follow-ups.
          </p>
        </div>
      </div>

      {calls.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center space-y-3">
          <h2 className="text-base font-semibold text-slate-900">No call records yet</h2>
          <p className="text-sm text-slate-500 max-w-md mx-auto">
            Place your first outbound pitch call via Twilio or run a browser rehearsal in the Voice Studio to see live transcripts and AI qualification summaries here.
          </p>
          <div className="pt-2">
            <button
              type="button"
              onClick={onStartNewCall}
              className="h-10 px-4 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold cursor-pointer"
            >
              Open Dialer
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Call History List */}
          <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  placeholder="Search calls..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-teal-700"
                />
              </div>

              <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100">
                {([
                  { id: 'all', label: 'All' },
                  { id: 'twilio', label: 'Twilio' },
                  { id: 'rehearsal', label: 'Rehearsals' },
                ] as const).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setChannelFilter(tab.id)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      channelFilter === tab.id
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="divide-y divide-slate-100 max-h-[620px] overflow-y-auto">
              {filtered.map((call) => {
                const isSelected = selectedCall?.id === call.id;
                return (
                  <button
                    key={call.id}
                    type="button"
                    onClick={() => setSelectedId(call.id)}
                    className={`w-full px-4 py-3.5 text-left transition-colors flex items-start justify-between gap-4 cursor-pointer ${
                      isSelected ? 'bg-teal-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">
                        {call.leadName} · {call.businessName}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-slate-500 mt-1 flex-wrap">
                        <span className="font-mono tabular-nums">{call.toNumber}</span>
                        <span aria-hidden="true">·</span>
                        <span>{call.channel === 'twilio' ? 'Twilio' : 'Rehearsal'}</span>
                        <span aria-hidden="true">·</span>
                        <span>{getVoiceAgentName(call.voiceName)}</span>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-medium text-slate-800">
                        {call.summary?.outcome || call.status}
                      </div>
                      <div className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                        {formatDuration(call.durationSec)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right: Call Detail Inspector */}
          <div className="lg:col-span-6 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            {selectedCall ? (
              <>
                <div className="pb-4 border-b border-slate-100 flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      {selectedCall.leadName} · {selectedCall.businessName}
                    </h2>
                    <div className="flex items-center gap-2 text-xs text-slate-500 mt-1 flex-wrap">
                      <span className="font-mono tabular-nums">{selectedCall.toNumber}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {new Date(selectedCall.startedAt).toLocaleString()}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{formatDuration(selectedCall.durationSec)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSummarize(selectedCall)}
                    disabled={summarizing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${summarizing ? 'animate-spin' : ''}`} />
                    {summarizing ? 'Analyzing...' : 'Analyze Call'}
                  </button>
                </div>

                {selectedCall.summary && (
                  <div className="p-4 rounded-lg bg-slate-50 border border-slate-200/80 space-y-2.5">
                    <div className="text-xs text-slate-500">
                      <span className="font-semibold text-slate-900">Outcome:</span>{' '}
                      <span className="font-medium text-teal-800">{selectedCall.summary.outcome}</span>
                    </div>
                    <p className="text-sm text-slate-700 leading-relaxed">{selectedCall.summary.summary}</p>
                    <div className="text-xs text-slate-600">
                      <span className="font-medium text-slate-900">Next Step: </span>
                      {selectedCall.summary.nextStep}
                    </div>
                    <div className="pt-2 border-t border-slate-200">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-slate-700">WhatsApp Follow-Up</span>
                        <button
                          type="button"
                          onClick={() => handleCopy(selectedCall.summary!.whatsappFollowUp)}
                          className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-900 cursor-pointer"
                        >
                          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          {copied ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <p className="text-xs text-slate-700 leading-relaxed">
                        {selectedCall.summary.whatsappFollowUp}
                      </p>
                    </div>
                  </div>
                )}

                <div>
                  <h3 className="text-xs font-semibold text-slate-900 mb-3">Conversation Transcript</h3>
                  <div className="space-y-3 max-h-[340px] overflow-y-auto pr-1">
                    {selectedCall.transcript.length === 0 ? (
                      <p className="text-xs text-slate-500">No spoken transcript recorded for this call.</p>
                    ) : (
                      selectedCall.transcript.map((line) => (
                        <div key={line.id} className="text-sm">
                          <div className="flex items-center gap-2 text-[11px] text-slate-500">
                            <span className="font-semibold text-slate-700">
                              {line.speaker === 'agent'
                                ? `${getVoiceAgentName(selectedCall.voiceName)} (WebDevs)`
                                : line.speaker === 'lead'
                                  ? selectedCall.leadName
                                  : 'Event'}
                            </span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono tabular-nums">
                              {new Date(line.timestamp).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit',
                              })}
                            </span>
                          </div>
                          <p className="text-slate-700 mt-0.5 leading-relaxed">{line.text}</p>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-slate-500">Select a call record to inspect details.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
