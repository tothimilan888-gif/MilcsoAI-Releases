import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useServer } from '../lib/server';
import { ACTION_LABEL, fmtDate } from '../lib/format';
import type { ConfigSchema, ModuleOverride, Overrides, ParamSpec } from '../lib/types';
import { useToast } from '../lib/toast';
import { PageHeader } from '../components/Layout';
import { Badge, ConfirmReason, Empty, ErrorState, FieldError, Loading } from '../components/ui';

interface ConfigResponse { version: number; overrides: Overrides; schema: ConfigSchema | null; updated_at: string; history: { version: number; changed_by_label: string; note: string; created_at: string }[]; canEdit: boolean }

const CAT: Record<string, string> = { movement: 'Mozgás és fizika', player: 'Játékosállapot', weapons: 'Fegyverek és sebzés', entities: 'Entitások és robbanások', events: 'Eventek és gazdaság', resources: 'Resource-ok', client: 'Kliensoldali jelzések' };

function effectiveModule(schema: ConfigSchema, key: string, ov: Overrides) {
  const spec = schema.modules[key]!;
  const o = ov.modules?.[key] ?? {};
  const params: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(spec.params ?? {})) params[k] = o.params?.[k] ?? p.default;
  return { enabled: o.enabled ?? spec.defaults.enabled, action: o.action ?? spec.defaults.action, severity: o.severity ?? spec.defaults.severity, params };
}

function ParamInput({ spec, value, onChange, disabled }: { spec: ParamSpec; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  if (spec.type === 'boolean') return <select value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value === 'true')}><option value="true">igen</option><option value="false">nem</option></select>;
  if (spec.type === 'enum') return <select value={String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{spec.values?.map((v) => <option key={v}>{v}</option>)}</select>;
  if (spec.type === 'list') return <textarea rows={2} disabled={disabled} value={(value as string[]).join(', ')} onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />;
  return <input type="number" disabled={disabled} min={spec.min} max={spec.max} step={spec.type === 'integer' ? 1 : 'any'} value={Number(value)} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
}

/** Builds a minimal overrides object: only values that differ from the schema defaults. */
export function diffOverrides(schema: ConfigSchema, draft: Record<string, ReturnType<typeof effectiveModule>>, risk: Record<string, unknown>): Overrides {
  const modules: Record<string, ModuleOverride> = {};
  for (const [key, m] of Object.entries(draft)) {
    const spec = schema.modules[key]!;
    const o: ModuleOverride = {};
    if (m.enabled !== spec.defaults.enabled) o.enabled = m.enabled;
    if (m.action !== spec.defaults.action) o.action = m.action;
    if (m.severity !== spec.defaults.severity) o.severity = m.severity;
    const params: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(spec.params ?? {})) if (JSON.stringify(m.params[k]) !== JSON.stringify(p.default)) params[k] = m.params[k];
    if (Object.keys(params).length) o.params = params;
    if (Object.keys(o).length) modules[key] = o;
  }
  const r: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(schema.risk ?? {})) if (JSON.stringify(risk[k]) !== JSON.stringify(p.default)) r[k] = risk[k];
  return { modules, risk: r };
}

export function ConfigPage() {
  const server = useServer();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['config', server.id], queryFn: () => api<ConfigResponse>('GET', `/servers/${server.id}/config`) });
  const [draft, setDraft] = useState<Record<string, ReturnType<typeof effectiveModule>>>({});
  const [risk, setRisk] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [rollback, setRollback] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const schema = q.data?.schema ?? null;

  const initial = useMemo(() => {
    if (!q.data?.schema) return null;
    const s = q.data.schema;
    const d: Record<string, ReturnType<typeof effectiveModule>> = {};
    for (const key of Object.keys(s.modules)) d[key] = effectiveModule(s, key, q.data.overrides ?? {});
    const r: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(s.risk ?? {})) r[k] = q.data.overrides?.risk?.[k] ?? p.default;
    return { draft: d, risk: r, baseline: JSON.stringify(diffOverrides(s, d, r)) };
  }, [q.data]);
  useEffect(() => {
    if (!initial) return;
    setDraft(initial.draft);
    setRisk(initial.risk);
  }, [initial]);

  const overrides = useMemo(() => (schema ? diffOverrides(schema, draft, risk) : {}), [schema, draft, risk]);
  const dirty = !!initial && JSON.stringify(overrides) !== initial.baseline;

  const save = useMutation({
    mutationFn: (note: string) => api<{ version: number }>('PUT', `/servers/${server.id}/config`, { overrides, expectedVersion: q.data!.version, note }),
    onSuccess: (r) => { toast(`Mentve (v${r.version}). A játékszerver a következő szinkronnál alkalmazza és újra validálja.`, 'success'); void qc.invalidateQueries({ queryKey: ['config', server.id] }); },
  });

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (!schema) return <><PageHeader title="Anticheat beállítások" /><Empty title="A játékszerver még nem jelentkezett be">A beállítás-séma a FiveM resource első sikeres csatlakozásakor érkezik meg. Állíts be API-kulcsot (API-kulcsok oldal), majd indítsd újra a resource-ot.</Empty></>;
  const canEdit = q.data!.canEdit;
  const cats: Record<string, string[]> = {};
  for (const [key, spec] of Object.entries(schema.modules)) {
    if (filter && !`${key} ${spec.label}`.toLowerCase().includes(filter.toLowerCase())) continue;
    (cats[spec.category] ??= []).push(key);
  }
  const upd = (key: string, patch: Partial<ReturnType<typeof effectiveModule>>) => setDraft((d) => ({ ...d, [key]: { ...d[key]!, ...patch } }));

  return (
    <>
      <PageHeader title="Anticheat beállítások" subtitle={<>v{q.data!.version} · módosítva {fmtDate(q.data!.updated_at)}. A kliensoldali modulok soha nem állíthatók automatikus banra.</>}
        actions={canEdit && <button className="btn primary" disabled={!dirty || save.isPending} onClick={() => setSaving(true)}>Mentés…</button>} />
      <FieldError error={save.error} />
      <div className="grid config-layout">
        <div>
          <div className="filters"><input type="search" placeholder="Modul keresése…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Modul keresése" /></div>
          {Object.entries(cats).map(([cat, keys]) => (
            <section className="card" key={cat}>
              <h2>{CAT[cat] ?? cat}</h2>
              {keys.map((key) => {
                const spec = schema.modules[key]!;
                const m = draft[key];
                if (!m) return null;
                return (
                  <div className={`module ${m.enabled ? '' : 'off'}`} key={key}>
                    <div className="module-head">
                      <div>
                        <div className="module-name">{spec.label} <code className="muted">{key}</code> {spec.source === 'client' && <Badge tone="warn">kliens</Badge>}</div>
                        <div className="muted small">{spec.description}</div>
                        {spec.limitations && <div className="limit small">Korlát: {spec.limitations}</div>}
                      </div>
                      <div className="module-controls">
                        <select value={m.action} disabled={!canEdit} onChange={(e) => upd(key, { action: e.target.value })} aria-label="Intézkedés">
                          {schema.actions.filter((a) => !(spec.source === 'client' && a === 'ban')).map((a) => <option key={a} value={a}>{ACTION_LABEL[a] ?? a}</option>)}
                        </select>
                        <select value={m.severity} disabled={!canEdit} onChange={(e) => upd(key, { severity: e.target.value })} aria-label="Súlyosság">{schema.severities.map((s) => <option key={s}>{s}</option>)}</select>
                        <label className="switch" title="Engedélyezve"><input type="checkbox" checked={m.enabled} disabled={!canEdit} onChange={(e) => upd(key, { enabled: e.target.checked })} /><span /></label>
                      </div>
                    </div>
                    {Object.keys(spec.params ?? {}).length > 0 && (
                      <div className="params">
                        {Object.entries(spec.params).map(([pk, ps]) => (
                          <label className="field" key={pk}>
                            <span>{ps.label}{ps.unit ? ` (${ps.unit})` : ''}{ps.min !== undefined && <span className="muted"> [{ps.min}–{ps.max}]</span>}</span>
                            <ParamInput spec={ps} value={m.params[pk]} disabled={!canEdit} onChange={(v) => upd(key, { params: { ...m.params, [pk]: v } })} />
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}
        </div>
        <aside>
          <section className="card">
            <h2>Kockázati rendszer</h2>
            <div className="params single">
              {Object.entries(schema.risk ?? {}).map(([k, ps]) => (
                <label className="field" key={k}><span>{ps.label}{ps.unit ? ` (${ps.unit})` : ''}</span><ParamInput spec={ps} value={risk[k]} disabled={!canEdit} onChange={(v) => setRisk((r) => ({ ...r, [k]: v }))} /></label>
              ))}
            </div>
            <p className="muted small">Ban csak akkor történik automatikusan, ha legalább a megadott számú független, szerveroldali detektálástípus támasztja alá (vagy a jel önmagában perdöntő, pl. csapda event). A circuit breaker a megadott számú auto-ban után kickre vált.</p>
          </section>
          <section className="card">
            <h2>Verziótörténet</h2>
            {q.data!.history.length === 0 ? <p className="muted">Még nincs módosítás – az alapértékek érvényesek.</p> : (
              <ul className="timeline">{q.data!.history.map((h) => (
                <li key={h.version}><b>v{h.version}</b> – {h.changed_by_label} <span className="muted small">{fmtDate(h.created_at)}</span><div className="small">{h.note}</div>
                  {canEdit && h.version !== q.data!.version && <button className="btn sm ghost" onClick={() => setRollback(h.version)}>Visszaállítás</button>}</li>
              ))}</ul>
            )}
          </section>
        </aside>
      </div>
      {saving && <ConfirmReason title="Beállítások mentése" description={`${Object.keys(overrides.modules ?? {}).length} modul és ${Object.keys(overrides.risk ?? {}).length} kockázati paraméter tér el az alapértéktől. A játékszerver újra validálja; hibás konfigurációt egészében elutasít.`} confirmLabel="Mentés" onClose={() => setSaving(false)} onConfirm={(note) => save.mutateAsync(note)} />}
      {rollback !== null && <ConfirmReason title={`Visszaállítás: v${rollback}`} reasonLabel="Megerősítés: írd be, miért" confirmLabel="Visszaállítás" onClose={() => setRollback(null)}
        onConfirm={async () => { await api('POST', `/servers/${server.id}/config/rollback`, { version: rollback, expectedVersion: q.data!.version }); toast('Visszaállítva', 'success'); void qc.invalidateQueries({ queryKey: ['config', server.id] }); }} />}
    </>
  );
}
