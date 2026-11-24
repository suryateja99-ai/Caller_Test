import { useMemo, useState } from 'react';
import { PhoneCall, Plus, Search, Trash2, X } from 'lucide-react';
import type { Lead, LeadStage, ServiceFocus } from '../types';
import { apiJson } from '../lib/api';

interface LeadsViewProps {
  leads: Lead[];
  onDialLead: (lead: Lead) => void;
  onLeadCreated: (lead: Lead) => void;
  onLeadUpdated: (lead: Lead) => void;
  onLeadDeleted: (id: string) => void;
}

const STAGES: ('All' | LeadStage)[] = ['All', 'New', 'Contacted', 'Interested', 'Follow-up', 'Not Interested'];

const SERVICE_SHORT: Record<ServiceFocus, string> = {
  web_app: 'Web App',
  mobile_app: 'Mobile App',
  meta_ads: 'Meta Ads',
};

const STAGE_TEXT_COLOR: Record<LeadStage, string> = {
  New: 'text-slate-700',
  Contacted: 'text-sky-700',
  Interested: 'text-emerald-700',
  'Follow-up': 'text-amber-700',
  'Not Interested': 'text-slate-400',
};

export function LeadsView({
  leads,
  onDialLead,
  onLeadCreated,
  onLeadUpdated,
  onLeadDeleted,
}: LeadsViewProps) {
  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<'All' | LeadStage>('All');
  const [showAddForm, setShowAddForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [newLead, setNewLead] = useState<{
    name: string;
    phone: string;
    businessName: string;
    businessType: string;
    location: string;
    focusServices: ServiceFocus[];
    notes: string;
  }>({
    name: '',
    phone: '+91',
    businessName: '',
    businessType: '',
    location: 'Hyderabad',
    focusServices: ['web_app', 'meta_ads'],
    notes: '',
  });

  const filteredLeads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return leads.filter((lead) => {
      if (stageFilter !== 'All' && lead.stage !== stageFilter) return false;
      if (!q) return true;
      return (
        lead.name.toLowerCase().includes(q) ||
        lead.businessName.toLowerCase().includes(q) ||
        lead.businessType.toLowerCase().includes(q) ||
        lead.phone.toLowerCase().includes(q) ||
        lead.location.toLowerCase().includes(q)
      );
    });
  }, [leads, search, stageFilter]);

  const toggleNewService = (svc: ServiceFocus) => {
    setNewLead((prev) => {
      const exists = prev.focusServices.includes(svc);
      if (exists && prev.focusServices.length === 1) return prev;
      return {
        ...prev,
        focusServices: exists
          ? prev.focusServices.filter((s) => s !== svc)
          : [...prev.focusServices, svc],
      };
    });
  };

  const handleCreateLead = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const result = await apiJson<{ lead?: Lead; error?: string }>('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newLead,
          phone: newLead.phone.replace(/[\s\-()]/g, ''),
        }),
      });
      if (!result.ok || !result.data?.lead) {
        throw new Error(result.error || 'Could not add lead.');
      }
      onLeadCreated(result.data.lead);
      setNewLead({
        name: '',
        phone: '+91',
        businessName: '',
        businessType: '',
        location: 'Hyderabad',
        focusServices: ['web_app', 'meta_ads'],
        notes: '',
      });
      setShowAddForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save lead.');
    } finally {
      setSaving(false);
    }
  };

  const handleStageChange = async (leadId: string, stage: LeadStage) => {
    const result = await apiJson<{ lead?: Lead }>(`/api/leads/${encodeURIComponent(leadId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stage }),
    });
    if (result.ok && result.data?.lead) {
      onLeadUpdated(result.data.lead);
    }
  };

  const handleDelete = async (leadId: string) => {
    const result = await apiJson(`/api/leads/${encodeURIComponent(leadId)}`, { method: 'DELETE' });
    if (result.ok) {
      onLeadDeleted(leadId);
    }
  };

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900 tracking-tight">Lead Queue</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Manage Hyderabad SMB prospects and launch tailored Tenglish outbound calls in one click.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAddForm((v) => !v)}
          className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {showAddForm ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          {showAddForm ? 'Close Form' : 'Add Lead'}
        </button>
      </div>

      {/* Inline Add Lead Form */}
      {showAddForm && (
        <form
          onSubmit={handleCreateLead}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
        >
          <div className="text-sm font-semibold text-slate-900">New Prospect</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="nl-name" className="block text-xs font-medium text-slate-700 mb-1">
                Contact Name
              </label>
              <input
                id="nl-name"
                required
                value={newLead.name}
                onChange={(e) => setNewLead((p) => ({ ...p, name: e.target.value }))}
                placeholder="Sandeep Kumar"
                className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-teal-700"
              />
            </div>
            <div>
              <label htmlFor="nl-phone" className="block text-xs font-medium text-slate-700 mb-1">
                Phone Number (E.164)
              </label>
              <input
                id="nl-phone"
                required
                value={newLead.phone}
                onChange={(e) => setNewLead((p) => ({ ...p, phone: e.target.value }))}
                placeholder="+919848011223"
                className="w-full h-10 px-3 rounded-lg border border-slate-200 font-mono tabular-nums text-sm focus:outline-none focus:border-teal-700"
              />
            </div>
            <div>
              <label htmlFor="nl-business" className="block text-xs font-medium text-slate-700 mb-1">
                Business Name
              </label>
              <input
                id="nl-business"
                required
                value={newLead.businessName}
                onChange={(e) => setNewLead((p) => ({ ...p, businessName: e.target.value }))}
                placeholder="Banjara Roast Cafe"
                className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-teal-700"
              />
            </div>
            <div>
              <label htmlFor="nl-type" className="block text-xs font-medium text-slate-700 mb-1">
                Business Category
              </label>
              <input
                id="nl-type"
                value={newLead.businessType}
                onChange={(e) => setNewLead((p) => ({ ...p, businessType: e.target.value }))}
                placeholder="Cafe & Specialty Bakery"
                className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-teal-700"
              />
            </div>
            <div>
              <label htmlFor="nl-loc" className="block text-xs font-medium text-slate-700 mb-1">
                Location
              </label>
              <input
                id="nl-loc"
                value={newLead.location}
                onChange={(e) => setNewLead((p) => ({ ...p, location: e.target.value }))}
                placeholder="Jubilee Hills, Hyderabad"
                className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-teal-700"
              />
            </div>
            <div>
              <span className="block text-xs font-medium text-slate-700 mb-1">Target Services</span>
              <div className="flex items-center gap-1.5 h-10">
                {(['web_app', 'mobile_app', 'meta_ads'] as const).map((svc) => {
                  const active = newLead.focusServices.includes(svc);
                  return (
                    <button
                      key={svc}
                      type="button"
                      onClick={() => toggleNewService(svc)}
                      className={`px-2.5 py-1.5 rounded-md border text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                        active
                          ? 'border-teal-700 bg-teal-50 text-teal-900'
                          : 'border-slate-200 bg-white text-slate-600'
                      }`}
                    >
                      {SERVICE_SHORT[svc]}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="nl-notes" className="block text-xs font-medium text-slate-700 mb-1">
              Pitch Context Notes
            </label>
            <input
              id="nl-notes"
              value={newLead.notes}
              onChange={(e) => setNewLead((p) => ({ ...p, notes: e.target.value }))}
              placeholder="e.g., Expanding to 2nd branch in Kondapur, interested in Instagram lead ads..."
              className="w-full h-10 px-3 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-teal-700"
            />
          </div>

          {formError && (
            <div role="alert" className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-2.5">
              {formError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="h-9 px-3.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="h-9 px-4 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold cursor-pointer"
            >
              {saving ? 'Saving...' : 'Save Lead'}
            </button>
          </div>
        </form>
      )}

      {/* Filter & Search Bar */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              placeholder="Search name, business, or phone..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700"
            />
          </div>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 overflow-x-auto">
            {STAGES.map((stage) => (
              <button
                key={stage}
                type="button"
                onClick={() => setStageFilter(stage)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  stageFilter === stage
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {stage}
              </button>
            ))}
          </div>
        </div>

        {/* High-Density Data Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-100 text-xs font-medium text-slate-500 bg-slate-50/60">
                <th className="py-3 px-4">Lead &amp; Business</th>
                <th className="py-3 px-4">Phone</th>
                <th className="py-3 px-4">Focus Services</th>
                <th className="py-3 px-4">Stage</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredLeads.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 text-center text-sm text-slate-500">
                    No leads match your filter. Add a new lead to start pitching.
                  </td>
                </tr>
              ) : (
                filteredLeads.map((lead) => (
                  <tr key={lead.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3 px-4">
                      <div className="font-medium text-slate-900">{lead.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {lead.businessName} · {lead.businessType} · {lead.location}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-xs text-slate-700 whitespace-nowrap">
                      {lead.phone}
                    </td>
                    <td className="py-3 px-4 text-xs text-slate-600 whitespace-nowrap">
                      {lead.focusServices.map((s) => SERVICE_SHORT[s]).join(' · ')}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <select
                        aria-label={`Stage for ${lead.name}`}
                        value={lead.stage}
                        onChange={(e) => handleStageChange(lead.id, e.target.value as LeadStage)}
                        className={`text-xs font-medium bg-transparent border border-slate-200 rounded-md px-2 py-1 focus:outline-none focus:border-teal-700 ${STAGE_TEXT_COLOR[lead.stage]}`}
                      >
                        {STAGES.filter((s): s is LeadStage => s !== 'All').map((st) => (
                          <option key={st} value={st} className="text-slate-900">
                            {st}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onDialLead(lead)}
                          className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-teal-700 hover:bg-teal-800 text-white text-xs font-medium transition-colors cursor-pointer"
                        >
                          <PhoneCall className="w-3.5 h-3.5" />
                          Dial
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(lead.id)}
                          aria-label={`Delete ${lead.name}`}
                          className="inline-flex items-center justify-center w-8 h-8 rounded-md text-slate-400 hover:text-red-700 hover:bg-red-50 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
