import { useEffect, useRef, useState } from 'react';
import {
  History,
  Menu,
  Mic,
  PhoneCall,
  Users,
  X,
} from 'lucide-react';
import type { CallRecord, Lead, ServerConfigStatus } from './types';
import { apiJson } from './lib/api';
import { DialerView, type CallDraft } from './components/DialerView';
import { VoiceStudioView } from './components/VoiceStudioView';
import { LeadsView } from './components/LeadsView';
import { CallLogsView } from './components/CallLogsView';

type ActiveSection = 'dialer' | 'studio' | 'leads' | 'logs';

const NAV_ITEMS: { id: ActiveSection; label: string; icon: typeof PhoneCall }[] = [
  { id: 'dialer', label: 'Outbound Dialer', icon: PhoneCall },
  { id: 'studio', label: 'Voice Studio', icon: Mic },
  { id: 'leads', label: 'Lead Queue', icon: Users },
  { id: 'logs', label: 'Call Logs', icon: History },
];

const BREADCRUMBS: Record<ActiveSection, string> = {
  dialer: 'Outbound Dialer',
  studio: 'Voice Studio',
  leads: 'Lead Queue',
  logs: 'Call Logs',
};

export default function App() {
  const [section, setSection] = useState<ActiveSection>('dialer');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [activeCallId, setActiveCallId] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<ServerConfigStatus | null>(null);

  const [draft, setDraft] = useState<CallDraft>({
    toNumber: '+919848011223',
    leadName: 'Karthik Reddy',
    businessName: 'Deccan Spice Kitchen',
    businessType: 'Cloud Kitchen & Biryani Delivery',
    focusServices: ['web_app', 'mobile_app', 'meta_ads'],
    voiceName: 'Aoede',
    customNotes: 'Looking to grow direct orders around HITEC City and run local Instagram lead ads.',
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  // Upsert helpers (idempotent against reconnect races)
  const upsertCall = (incoming: CallRecord) => {
    setCalls((prev) => {
      const idx = prev.findIndex((c) => c.id === incoming.id);
      if (idx === -1) return [incoming, ...prev];
      const next = [...prev];
      next[idx] = incoming;
      return next;
    });
  };

  const upsertLead = (incoming: Lead) => {
    setLeads((prev) => {
      const idx = prev.findIndex((l) => l.id === incoming.id);
      if (idx === -1) return [incoming, ...prev];
      const next = [...prev];
      next[idx] = incoming;
      return next;
    });
  };

  useEffect(() => {
    // Load initial config status, leads, and calls
    void (async () => {
      try {
        const [cfgRes, leadsRes, callsRes] = await Promise.all([
          apiJson<ServerConfigStatus>('/api/config/status'),
          apiJson<{ leads?: Lead[] }>('/api/leads'),
          apiJson<{ calls?: CallRecord[] }>('/api/calls'),
        ]);
        if (cfgRes.ok && cfgRes.data) {
          setConfigStatus(cfgRes.data);
        }
        if (leadsRes.ok && Array.isArray(leadsRes.data?.leads)) {
          setLeads(leadsRes.data.leads);
        }
        if (callsRes.ok && Array.isArray(callsRes.data?.calls)) {
          setCalls(callsRes.data.calls);
        }
      } catch {
        // retry via websocket
      }
    })();

    // Real-time dashboard sync WebSocket with auto-reconnect
    let disposed = false;
    const connectDashboardWs = () => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/dashboard`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as {
            type: string;
            calls?: CallRecord[];
            leads?: Lead[];
            call?: CallRecord;
            lead?: Lead;
            id?: string;
          };
          if (msg.type === 'init') {
            if (Array.isArray(msg.calls)) setCalls(msg.calls);
            if (Array.isArray(msg.leads)) setLeads(msg.leads);
          } else if ((msg.type === 'call:created' || msg.type === 'call:updated') && msg.call) {
            upsertCall(msg.call);
          } else if ((msg.type === 'lead:created' || msg.type === 'lead:updated') && msg.lead) {
            upsertLead(msg.lead);
          } else if (msg.type === 'lead:deleted' && msg.id) {
            setLeads((prev) => prev.filter((l) => l.id !== msg.id));
          }
        } catch {
          // ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (!disposed) {
          reconnectTimerRef.current = window.setTimeout(connectDashboardWs, 2500);
        }
      };
    };

    connectDashboardWs();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        void fetch('/api/twilio/health', { credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  const activeCall = calls.find((c) => c.id === activeCallId) ?? null;

  const handleDialLead = (lead: Lead) => {
    setDraft((prev) => ({
      ...prev,
      leadId: lead.id,
      toNumber: lead.phone,
      leadName: lead.name,
      businessName: lead.businessName,
      businessType: lead.businessType,
      focusServices: lead.focusServices,
      customNotes: lead.notes,
    }));
    setSection('dialer');
  };

  const handleNavClick = (next: ActiveSection) => {
    setSection(next);
    setMobileMenuOpen(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar (252px) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-[252px] lg:shrink-0 bg-white border-r border-slate-200 sticky top-0 h-screen">
        <div className="h-16 px-6 flex items-center border-b border-slate-100">
          <a
            href="#dialer"
            onClick={(e) => {
              e.preventDefault();
              setSection('dialer');
            }}
            className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            WebDevs Voice
          </a>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavClick(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-teal-50 text-teal-900'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </span>
                {item.id === 'leads' && (
                  <span className="font-mono tabular-nums text-xs text-slate-400">{leads.length}</span>
                )}
                {item.id === 'logs' && calls.length > 0 && (
                  <span className="font-mono tabular-nums text-xs text-slate-400">{calls.length}</span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Quiet Server Line Info */}
        <div className="p-5 border-t border-slate-100 text-xs space-y-1.5">
          <div className="font-medium text-slate-700">Twilio Caller Line</div>
          <div className="font-mono tabular-nums text-slate-500">
            {configStatus?.twilioConfigured
              ? configStatus.twilioFromNumberMasked
              : 'Not configured in Secrets'}
          </div>
          <div className="text-slate-400">Hyderabad Tenglish · WebDevs</div>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative w-64 max-w-[80vw] bg-white h-full border-r border-slate-200 flex flex-col z-50">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-100">
              <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
                WebDevs Voice
              </span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation"
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavClick(item.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap ${
                      active ? 'bg-teal-50 text-teal-900' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb on Left, Single Primary CTA on Right */}
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-8 flex items-center justify-between gap-8 sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation"
              className="lg:hidden p-2 -ml-2 rounded-lg text-slate-600 hover:bg-slate-100"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm text-slate-500 truncate">
              <span className="hidden sm:inline font-medium text-slate-600">WebDevs</span>
              <span className="hidden sm:inline text-slate-300" aria-hidden="true">/</span>
              <span className="font-semibold text-slate-900 truncate">{BREADCRUMBS[section]}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {section === 'dialer' ? (
              <button
                type="button"
                onClick={() => setSection('studio')}
                className="h-9 px-4 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Test Voice Live
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setSection('dialer')}
                className="h-9 px-4 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                New Outbound Call
              </button>
            )}
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 p-4 sm:p-8 max-w-[1280px] w-full mx-auto">
          {section === 'dialer' && (
            <DialerView
              draft={draft}
              onDraftChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
              leads={leads}
              activeCall={activeCall}
              recentCalls={calls}
              configStatus={configStatus}
              onSelectCall={(call) => {
                upsertCall(call);
                setActiveCallId(call.id);
              }}
              onCallStarted={(call) => {
                upsertCall(call);
                setActiveCallId(call.id);
              }}
              onOpenVoiceStudio={() => setSection('studio')}
            />
          )}

          {section === 'studio' && (
            <VoiceStudioView
              draft={draft}
              onDraftChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
              onRehearsalCallCreated={(call) => {
                upsertCall(call);
                setActiveCallId(call.id);
              }}
            />
          )}

          {section === 'leads' && (
            <LeadsView
              leads={leads}
              onDialLead={handleDialLead}
              onLeadCreated={upsertLead}
              onLeadUpdated={upsertLead}
              onLeadDeleted={(id) => setLeads((prev) => prev.filter((l) => l.id !== id))}
            />
          )}

          {section === 'logs' && (
            <CallLogsView
              calls={calls}
              onCallUpdated={upsertCall}
              onStartNewCall={() => setSection('dialer')}
            />
          )}
        </main>
      </div>
    </div>
  );
}
