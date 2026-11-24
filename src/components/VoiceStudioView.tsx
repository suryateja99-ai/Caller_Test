import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Mic,
  MicOff,
  PhoneOff,
  Play,
  Square,
  Volume2,
  Wand2,
} from 'lucide-react';
import type { CallRecord, PitchPlaybook } from '../types';
import type { CallDraft } from './DialerView';
import { AgentAvatar } from './AgentAvatar';
import { apiJson } from '../lib/api';
import { getVoiceAgentName, getVoiceTeluguName, PRIMARY_VOICE_OPTIONS } from '../lib/voices';
import { computeRmsLevel, float32ToPcm16Base64, GaplessPcmPlayer } from '../lib/audioPlayer';

interface VoiceStudioViewProps {
  draft: CallDraft;
  onDraftChange: (patch: Partial<CallDraft>) => void;
  onRehearsalCallCreated: (call: CallRecord) => void;
}

const SAMPLE_OBJECTIONS = [
  'కొంచెం బిజీగా ఉన్నాను, ఒక నిమిషంలో చెప్పండి.',
  'ఆల్రెడీ మాకు వెబ్‌సైట్ ఉంది, కొత్త యాప్ ఎందుకు?',
  'Meta ads లో ముందు ట్రై చేశాం, ప్రాపర్ లీడ్స్ రాలేదు.',
  'బడ్జెట్ కొంచెం టైట్ ఉంది ఈ నెల, రఫ్‌గా ఎంత అవుతుంది?',
];

export function VoiceStudioView({
  draft,
  onDraftChange,
  onRehearsalCallCreated,
}: VoiceStudioViewProps) {
  // Live voice rehearsal state
  const [liveState, setLiveState] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [muted, setMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [liveCall, setLiveCall] = useState<CallRecord | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [customLineInput, setCustomLineInput] = useState('');

  // Script playbook & TTS audition state
  const [playbook, setPlaybook] = useState<PitchPlaybook | null>(null);
  const [generatingPlaybook, setGeneratingPlaybook] = useState(false);
  const [playbookError, setPlaybookError] = useState<string | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [loadingAudioKey, setLoadingAudioKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Refs to prevent stale closures in audio processor & WS callbacks
  const wsRef = useRef<WebSocket | null>(null);
  const inputCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const playerRef = useRef<GaplessPcmPlayer | null>(null);
  const mutedRef = useRef(false);
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsAudioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const stopLiveRehearsal = () => {
    try {
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'stop' }));
      }
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;

    try {
      processorRef.current?.disconnect();
    } catch {
      // ignore
    }
    processorRef.current = null;

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }

    if (inputCtxRef.current && inputCtxRef.current.state !== 'closed') {
      void inputCtxRef.current.close();
    }
    inputCtxRef.current = null;

    playerRef.current?.dispose();
    playerRef.current = null;

    setMicLevel(0);
    setLiveState('idle');
  };

  useEffect(() => {
    return () => {
      stopLiveRehearsal();
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
      }
      if (ttsAudioUrlRef.current) {
        URL.revokeObjectURL(ttsAudioUrlRef.current);
      }
    };
  }, []);

  const startLiveRehearsal = async () => {
    setLiveError(null);
    setLiveState('connecting');
    setMuted(false);
    mutedRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaStreamRef.current = stream;

      const inputCtx = new AudioContext({ sampleRate: 16000 });
      inputCtxRef.current = inputCtx;
      const source = inputCtx.createMediaStreamSource(stream);
      // 1024 samples @ 16kHz = 64ms chunks for fast, responsive barge-in when human speaks
      const processor = inputCtx.createScriptProcessor(1024, 1, 1);
      processorRef.current = processor;

      const player = new GaplessPcmPlayer();
      playerRef.current = player;

      const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${wsProto}//${window.location.host}/ws/live-simulator`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'start',
            config: {
              leadId: draft.leadId,
              leadName: draft.leadName || 'Karthik',
              businessName: draft.businessName || 'Deccan Spice Kitchen',
              businessType: draft.businessType || 'Cloud Kitchen',
              focusServices: draft.focusServices,
              customNotes: draft.customNotes,
              voiceName: draft.voiceName,
            },
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type: string;
            audio?: string;
            call?: CallRecord;
            error?: string;
          };

          if (msg.type === 'ready' && msg.call) {
            setLiveState('live');
            setLiveCall(msg.call);
            onRehearsalCallCreated(msg.call);
          } else if (msg.type === 'audio' && msg.audio) {
            playerRef.current?.enqueuePcm24kBase64(msg.audio);
          } else if (msg.type === 'interrupted') {
            playerRef.current?.interrupt();
          } else if (msg.type === 'transcript' && msg.call) {
            setLiveCall(msg.call);
          } else if (msg.type === 'error') {
            setLiveError(msg.error || 'Voice stream encountered an error.');
            stopLiveRehearsal();
          } else if (msg.type === 'ended') {
            stopLiveRehearsal();
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onerror = () => {
        setLiveError('Could not connect to the live voice server.');
        stopLiveRehearsal();
      };

      ws.onclose = () => {
        if (wsRef.current === ws) {
          stopLiveRehearsal();
        }
      };

      source.connect(processor);
      processor.connect(inputCtx.destination);

      processor.onaudioprocess = (e) => {
        const channelData = e.inputBuffer.getChannelData(0);
        if (mutedRef.current) {
          setMicLevel(0);
          return;
        }
        setMicLevel(computeRmsLevel(channelData));
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const pcmBase64 = float32ToPcm16Base64(channelData);
          wsRef.current.send(JSON.stringify({ type: 'audio', audio: pcmBase64 }));
        }
      };
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Microphone access is required for live voice rehearsal.';
      setLiveError(msg);
      stopLiveRehearsal();
    }
  };

  const sendSimulatedLeadText = (text: string) => {
    const clean = text.trim();
    if (!clean || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    // Immediately stop AI playback when injecting a human interruption
    playerRef.current?.interrupt();
    wsRef.current.send(JSON.stringify({ type: 'text', text: clean }));
  };

  const handleGeneratePlaybook = async () => {
    setGeneratingPlaybook(true);
    setPlaybookError(null);
    try {
      const result = await apiJson<{ playbook?: PitchPlaybook; error?: string }>('/api/pitch/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leadName: draft.leadName || 'Karthik Reddy',
          businessName: draft.businessName || 'Deccan Spice Kitchen',
          businessType: draft.businessType || 'Cloud Kitchen & Catering',
          focusServices: draft.focusServices,
          customNotes: draft.customNotes,
          voiceName: draft.voiceName,
        }),
      });
      if (!result.ok || !result.data?.playbook) {
        throw new Error(result.error || 'Could not generate Tenglish pitch script.');
      }
      setPlaybook(result.data.playbook);
    } catch (err) {
      setPlaybookError(err instanceof Error ? err.message : 'Failed to generate script.');
    } finally {
      setGeneratingPlaybook(false);
    }
  };

  const stopTtsAudio = () => {
    if (ttsAudioRef.current) {
      ttsAudioRef.current.pause();
      ttsAudioRef.current = null;
    }
    if (ttsAudioUrlRef.current) {
      URL.revokeObjectURL(ttsAudioUrlRef.current);
      ttsAudioUrlRef.current = null;
    }
    setPlayingKey(null);
  };

  const handlePreviewVoice = async (key: string, text: string) => {
    if (playingKey === key) {
      stopTtsAudio();
      return;
    }
    stopTtsAudio();
    setLoadingAudioKey(key);
    setPlaybookError(null);

    try {
      const result = await apiJson<{ audioBase64?: string; mimeType?: string; error?: string }>(
        '/api/pitch/preview-audio',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            voiceName: draft.voiceName,
          }),
        }
      );
      if (!result.ok || !result.data?.audioBase64) {
        throw new Error(result.error || 'Voice preview failed.');
      }

      const binary = atob(result.data.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: result.data.mimeType || 'audio/wav' });
      const url = URL.createObjectURL(blob);
      ttsAudioUrlRef.current = url;

      const audio = new Audio(url);
      ttsAudioRef.current = audio;
      setPlayingKey(key);
      audio.onended = () => {
        stopTtsAudio();
      };
      audio.onerror = () => {
        stopTtsAudio();
      };
      await audio.play();
    } catch (err) {
      setPlaybookError(err instanceof Error ? err.message : 'Failed to play audio preview.');
    } finally {
      setLoadingAudioKey(null);
    }
  };

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // ignore
    }
  };

  const agentName = getVoiceAgentName(draft.voiceName);
  const agentTeluguName = getVoiceTeluguName(draft.voiceName);

  return (
    <div className="space-y-6">
      {/* Section 1: Interactive Live Voice Rehearsal */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-slate-100">
          <div className="flex items-center gap-3.5">
            <AgentAvatar name={agentName} size="md" />
            <div>
              <h1 className="text-lg font-semibold text-slate-900 tracking-tight">
                Live Hyderabadi Tenglish Voice Rehearsal
              </h1>
              <p className="text-sm text-slate-500 mt-0.5">
                Speak directly with {agentName} in real time to hear her tone, interrupt mid-sentence, and test lead objections before dialing via Twilio.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <div className="inline-flex items-center p-1 rounded-lg bg-slate-100">
              {PRIMARY_VOICE_OPTIONS.map((voice) => (
                <button
                  key={voice.id}
                  type="button"
                  disabled={liveState !== 'idle'}
                  onClick={() => onDraftChange({ voiceName: voice.id })}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60 ${
                    draft.voiceName === voice.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {voice.shortLabel}
                </button>
              ))}
            </div>

            {liveState === 'idle' ? (
              <button
                type="button"
                onClick={startLiveRehearsal}
                className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Mic className="w-4 h-4" />
                Start Live Call Test
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setMuted((m) => !m)}
                  className={`inline-flex items-center gap-1.5 h-10 px-3.5 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    muted
                      ? 'border-amber-300 bg-amber-50 text-amber-900'
                      : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                  {muted ? 'Unmute Mic' : 'Mute Mic'}
                </button>
                <button
                  type="button"
                  onClick={stopLiveRehearsal}
                  className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer"
                >
                  <PhoneOff className="w-4 h-4" />
                  End Rehearsal
                </button>
              </div>
            )}
          </div>
        </div>

        {liveError && (
          <div role="alert" className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
            {liveError}
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left: Live Controls & Objection Prompts */}
          <div className="lg:col-span-5 space-y-4">
            <div className="p-4 rounded-lg bg-slate-50 border border-slate-200/80 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700">Active Rehearsal Context</span>
                <span className="text-slate-500">
                  {liveState === 'live' ? (
                    <span className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                      <span className="w-2 h-2 rounded-full bg-emerald-600 animate-pulse" aria-hidden="true" />
                      Connected
                    </span>
                  ) : liveState === 'connecting' ? (
                    <span className="text-amber-700 font-medium">Connecting...</span>
                  ) : (
                    <span>Standby</span>
                  )}
                </span>
              </div>

              <div className="text-xs text-slate-600 space-y-1">
                <div>
                  <span className="text-slate-500">Lead:</span>{' '}
                  <span className="font-medium text-slate-900">
                    {draft.leadName || 'Karthik Reddy'} · {draft.businessName || 'Deccan Spice Kitchen'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500">Category:</span>{' '}
                  <span>{draft.businessType || 'Cloud Kitchen & Delivery'}</span>
                </div>
              </div>

              {/* Real mic level meter */}
              <div>
                <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                  <span>Microphone Input</span>
                  <span className="font-mono tabular-nums">
                    {liveState === 'live' ? (muted ? 'Muted' : `${Math.round(micLevel * 100)}%`) : 'Off'}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-slate-200 overflow-hidden">
                  <div
                    className="h-full bg-teal-600 transition-transform duration-100 origin-left"
                    style={{ transform: `scaleX(${liveState === 'live' && !muted ? Math.max(0.03, micLevel) : 0})` }}
                  />
                </div>
              </div>
            </div>

            <div>
              <div className="text-xs font-medium text-slate-700 mb-2">
                Test Common Hyderabad Lead Objections (Click while live)
              </div>
              <div className="space-y-1.5">
                {SAMPLE_OBJECTIONS.map((obj) => (
                  <button
                    key={obj}
                    type="button"
                    disabled={liveState !== 'live'}
                    onClick={() => sendSimulatedLeadText(obj)}
                    className="w-full text-left px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 text-xs text-slate-700 transition-colors cursor-pointer disabled:cursor-not-allowed"
                  >
                    &ldquo;{obj}&rdquo;
                  </button>
                ))}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendSimulatedLeadText(customLineInput);
                  setCustomLineInput('');
                }}
                className="mt-2.5 flex gap-2"
              >
                <input
                  type="text"
                  disabled={liveState !== 'live'}
                  placeholder="Type a lead reply to inject..."
                  value={customLineInput}
                  onChange={(e) => setCustomLineInput(e.target.value)}
                  className="flex-1 h-9 px-3 rounded-lg border border-slate-200 text-xs text-slate-900 placeholder:text-slate-400 disabled:bg-slate-50 focus:outline-none focus:border-teal-700"
                />
                <button
                  type="submit"
                  disabled={liveState !== 'live' || !customLineInput.trim()}
                  className="h-9 px-3.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-xs font-medium whitespace-nowrap cursor-pointer disabled:cursor-not-allowed"
                >
                  Send
                </button>
              </form>
            </div>
          </div>

          {/* Right: Live Rehearsal Transcript */}
          <div className="lg:col-span-7 border border-slate-200 rounded-lg p-5 bg-slate-50/40 min-h-[290px] max-h-[360px] overflow-y-auto flex flex-col">
            {liveCall && liveCall.transcript.length > 0 ? (
              <div className="space-y-3.5">
                {liveCall.transcript.map((entry) => {
                  if (entry.speaker === 'system') {
                    return (
                      <div key={entry.id} className="text-xs text-slate-500 border-b border-slate-200/60 pb-1.5">
                        {entry.text}
                      </div>
                    );
                  }
                  const isAgent = entry.speaker === 'agent';
                  return (
                    <div key={entry.id} className={`flex flex-col ${isAgent ? 'items-start' : 'items-end'}`}>
                      <span className="text-[11px] font-medium text-slate-500 mb-1">
                        {isAgent ? `${agentName} (WebDevs)` : 'You (Lead)'}
                      </span>
                      <div
                        className={`max-w-[88%] px-3.5 py-2.5 rounded-xl text-sm leading-relaxed ${
                          isAgent ? 'bg-white border border-slate-200 text-slate-900' : 'bg-teal-700 text-white'
                        }`}
                      >
                        {entry.text}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="my-auto text-center max-w-md mx-auto space-y-2">
                <p className="text-sm font-medium text-slate-700">
                  Press &ldquo;Start Live Call Test&rdquo; to talk with {agentName}
                </p>
                <p className="text-xs text-slate-500 leading-relaxed">
                  {agentName} will answer immediately in urban Hyderabadi Tenglish and pitch WebDevs&apos; Web App, Mobile App, and Meta Marketing services based on your lead details.
                </p>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Section 2: Tenglish Pitch Playbook & Studio Voice Audition */}
      <section className="bg-white border border-slate-200 rounded-xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-100">
          <div>
            <h2 className="text-base font-semibold text-slate-900 tracking-tight">
              Tenglish Pitch Playbook &amp; Voice Audition
            </h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Generate tailored Hyderabadi Tenglish talking points for{' '}
              <span className="font-medium text-slate-700">{draft.businessName || 'your lead'}</span> and
              audition any line using Gemini Speech Synthesis.
            </p>
          </div>
          <button
            type="button"
            onClick={handleGeneratePlaybook}
            disabled={generatingPlaybook}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Wand2 className="w-3.5 h-3.5" />
            {generatingPlaybook ? 'Crafting Tenglish Script...' : playbook ? 'Regenerate Playbook' : 'Generate Tenglish Playbook'}
          </button>
        </div>

        {playbookError && (
          <div role="alert" className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
            {playbookError}
          </div>
        )}

        {playbook ? (
          <div className="mt-6 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {[
                { key: 'opening', title: '01. Warm Opening Hook', text: playbook.openingHook },
                { key: 'webapp', title: '02. Web App Pitch', text: playbook.webAppPitch },
                { key: 'mobileapp', title: '03. Mobile App Pitch', text: playbook.mobileAppPitch },
                { key: 'metaads', title: '04. Meta Marketing & Ads Pitch', text: playbook.metaAdsPitch },
              ].map((block) => (
                <div key={block.key} className="p-4 rounded-lg border border-slate-200 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold text-slate-900">{block.title}</h3>
                    <button
                      type="button"
                      onClick={() => handlePreviewVoice(block.key, block.text)}
                      disabled={loadingAudioKey === block.key}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-200 hover:border-teal-700 hover:text-teal-800 text-xs font-medium text-slate-700 transition-colors whitespace-nowrap cursor-pointer"
                    >
                      {playingKey === block.key ? (
                        <>
                          <Square className="w-3 h-3 fill-current" />
                          Stop
                        </>
                      ) : loadingAudioKey === block.key ? (
                        <>
                          <Volume2 className="w-3 h-3 animate-pulse" />
                          Synthesizing...
                        </>
                      ) : (
                        <>
                          <Play className="w-3 h-3 fill-current" />
                          Listen
                        </>
                      )}
                    </button>
                  </div>
                  <p className="text-sm text-slate-700 leading-relaxed">{block.text}</p>
                </div>
              ))}
            </div>

            {/* Closing Ask & WhatsApp */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-2 border-t border-slate-100">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-900">05. Trust-First Closing Ask</h3>
                  <button
                    type="button"
                    onClick={() => handlePreviewVoice('closing', playbook.closingAsk)}
                    disabled={loadingAudioKey === 'closing'}
                    className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-900 cursor-pointer"
                  >
                    {playingKey === 'closing' ? <Square className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
                    {playingKey === 'closing' ? 'Stop' : loadingAudioKey === 'closing' ? 'Loading...' : 'Listen'}
                  </button>
                </div>
                <p className="text-sm text-slate-700 leading-relaxed">{playbook.closingAsk}</p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-slate-900">06. Post-Call WhatsApp Follow-Up</h3>
                  <button
                    type="button"
                    onClick={() => handleCopy('playbook-wa', playbook.whatsappMessage)}
                    className="inline-flex items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-900 cursor-pointer"
                  >
                    {copiedKey === 'playbook-wa' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedKey === 'playbook-wa' ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="text-sm text-slate-700 leading-relaxed">{playbook.whatsappMessage}</p>
              </div>
            </div>

            {/* Objection Handlers Table */}
            {playbook.objections.length > 0 && (
              <div className="pt-4 border-t border-slate-100">
                <h3 className="text-xs font-semibold text-slate-900 mb-3">
                  Hyderabadi Tenglish Objection Rebuttals
                </h3>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg overflow-hidden">
                  {playbook.objections.map((item, idx) => {
                    const objKey = `obj-${idx}`;
                    return (
                      <div key={objKey} className="p-4 bg-white flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                        <div className="space-y-1">
                          <div className="text-xs font-semibold text-slate-900">
                            Lead says: &ldquo;{item.objection}&rdquo;
                          </div>
                          <p className="text-sm text-slate-700 leading-relaxed">{item.tenglishResponse}</p>
                          <div className="text-xs text-slate-500">Trust tip: {item.trustTip}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handlePreviewVoice(objKey, item.tenglishResponse)}
                          disabled={loadingAudioKey === objKey}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-200 hover:border-teal-700 text-xs font-medium text-slate-700 whitespace-nowrap shrink-0 self-start cursor-pointer"
                        >
                          {playingKey === objKey ? (
                            <>
                              <Square className="w-3 h-3 fill-current" />
                              Stop
                            </>
                          ) : loadingAudioKey === objKey ? (
                            'Loading...'
                          ) : (
                            <>
                              <Play className="w-3 h-3 fill-current" />
                              Listen
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-6 py-8 text-center space-y-2">
            <p className="text-sm text-slate-600">
              Click &ldquo;Generate Tenglish Playbook&rdquo; to craft customized WebDevs scripts and audition {agentName}&apos;s voice on every line.
            </p>
            <p className="text-xs text-slate-500">
              Sample opener: &ldquo;హలో అండీ, నేను {agentTeluguName}ని, వెబ్‌డెవ్స్ నుంచి మాట్లాడుతున్నా. మీతో ఒక నిమిషం మాట్లాడవచ్చా అండీ?&rdquo;
            </p>
            <div className="pt-2">
              <button
                type="button"
                onClick={() =>
                  handlePreviewVoice(
                    'sample-opener',
                    `హలో అండీ, నేను ${agentTeluguName}ని, వెబ్‌డెవ్స్ నుంచి మాట్లాడుతున్నా. గూగుల్ లో మీ షాప్ కనిపిస్తుంది, ఇంకా కస్టమర్స్ డైరెక్ట్‌గా మీకు కాల్ చేయొచ్చు. మీతో ఒక నిమిషం మాట్లాడవచ్చా అండీ?`
                  )
                }
                disabled={loadingAudioKey === 'sample-opener'}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 hover:border-teal-700 text-xs font-semibold text-teal-800 transition-colors cursor-pointer"
              >
                {playingKey === 'sample-opener' ? (
                  <>
                    <Square className="w-3.5 h-3.5 fill-current" />
                    Stop Sample Voice
                  </>
                ) : loadingAudioKey === 'sample-opener' ? (
                  <>
                    <Volume2 className="w-3.5 h-3.5 animate-pulse" />
                    Synthesizing {agentName}&apos;s Voice...
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5 fill-current" />
                    Audition {agentName}&apos;s Natural Telugu Voice
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
