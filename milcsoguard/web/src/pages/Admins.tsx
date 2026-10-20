import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCan, useServer } from '../lib/server';
import { fmtRelative } from '../lib/format';
import type { Member, Role } from '../lib/types';
import { useToast } from '../lib/toast';
import { PageHeader } from '../components/Layout';
import { Badge, Empty, ErrorState, FieldError, Loading, Modal } from '../components/ui';

function RoleEditor({ role, perms, onClose }: { role: Role | null; perms: { key: string; description: string }[]; onClose: () => void }) {
  const server = useServer();
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({ key: role?.key ?? '', name: role?.name ?? '', level: role?.level ?? 20, permissions: new Set(role?.permissions ?? []) });
  const save = useMutation({
    mutationFn: () => role
      ? api('PUT', `/servers/${server.id}/roles/${role.id}`, { name: form.name, level: form.level, permissions: [...form.permissions] })
      : api('POST', `/servers/${server.id}/roles`, { key: form.key, name: form.name, level: form.level, permissions: [...form.permissions] }),
    onSuccess: () => { toast('Szerepkör mentve', 'success'); void qc.invalidateQueries({ queryKey: ['roles', server.id] }); onClose(); },
  });
  const mine = new Set(server.permissions);
  return (
    <Modal title={role ? `Szerepkör: ${role.name}` : 'Új egyedi szerepkör'} onClose={onClose} wide footer={<><button className="btn ghost" onClick={onClose}>Mégse</button><button className="btn primary" disabled={save.isPending} onClick={() => save.mutate()}>Mentés</button></>}>
      <div className="form-row">
        {!role && <label className="field"><span>Kulcs</span><input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} pattern="[a-z][a-z0-9_]{1,31}" placeholder="event_staff" /></label>}
        <label className="field"><span>Név</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field"><span>Szint (kisebb, mint a tiéd: {server.role.level})</span><input type="number" min={1} max={99} value={form.level} onChange={(e) => setForm({ ...form, level: Number(e.target.value) })} /></label>
      </div>
      <p className="muted small">Csak olyan jogosultságot adhatsz, amivel te is rendelkezel – a backend ezt kényszeríti.</p>
      <div className="perm-grid">
        {perms.map((p) => (
          <label key={p.key} className={`check ${mine.has(p.key) ? '' : 'disabled'}`} title={mine.has(p.key) ? p.description : 'Ezzel a joggal nem rendelkezel'}>
            <input type="checkbox" disabled={!mine.has(p.key)} checked={form.permissions.has(p.key)} onChange={(e) => { const n = new Set(form.permissions); if (e.target.checked) n.add(p.key); else n.delete(p.key); setForm({ ...form, permissions: n }); }} />
            <span><code>{p.key}</code><br /><span className="muted small">{p.description}</span></span>
          </label>
        ))}
      </div>
      <FieldError error={save.error} />
    </Modal>
  );
}

export function AdminsPage() {
  const server = useServer();
  const can = useCan();
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members', server.id], queryFn: () => api<{ items: Member[] }>('GET', `/servers/${server.id}/members`) });
  const roles = useQuery({ queryKey: ['roles', server.id], queryFn: () => api<{ items: Role[] }>('GET', `/servers/${server.id}/roles`) });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api<{ items: { key: string; description: string }[] }>('GET', '/permissions') });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', username: '', roleId: '' });
  const [tempPw, setTempPw] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<Role | null | 'new'>(null);
  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['members', server.id] }); };
  const add = useMutation({
    mutationFn: () => api<{ temporaryPassword?: string }>('POST', `/servers/${server.id}/members`, form),
    onSuccess: (r) => { invalidate(); setAdding(false); if (r.temporaryPassword) setTempPw(r.temporaryPassword); else toast('Meglévő fiók hozzáadva', 'success'); },
  });
  const change = useMutation({
    mutationFn: (v: { userId: string; roleId: string }) => api('PATCH', `/servers/${server.id}/members/${v.userId}`, { roleId: v.roleId }),
    onSuccess: () => { toast('Szerepkör módosítva', 'success'); invalidate(); },
    onError: (e) => { toast((e as Error).message, 'error'); invalidate(); },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api('DELETE', `/servers/${server.id}/members/${userId}`),
    onSuccess: () => { toast('Admin eltávolítva', 'success'); invalidate(); },
    onError: (e) => toast((e as Error).message, 'error'),
  });
  const assignable = (roles.data?.items ?? []).filter((r) => r.assignable);
  return (
    <>
      <PageHeader title="Adminok és jogosultságok" subtitle="Senki nem módosíthatja a saját szerepkörét, és csak a saját szintje alatti szerepkört oszthatja ki." actions={can('admins.manage') && <button className="btn primary" onClick={() => { setForm({ email: '', username: '', roleId: assignable[assignable.length - 1]?.id ?? '' }); setAdding(true); }}>+ Admin hozzáadása</button>} />
      <section className="card flush">
        {members.isLoading ? <Loading /> : members.error ? <ErrorState error={members.error} /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Felhasználó</th>{can('admins.manage') && <th>E-mail</th>}<th>Szerepkör</th><th>2FA</th><th>Kötött FiveM azonosítók</th><th>Utolsó belépés</th><th /></tr></thead>
            <tbody>{members.data!.items.map((m) => (
              <tr key={m.user_id}>
                <td><b>{m.username}</b> {m.user_id === me?.user.id && <Badge tone="accent">te</Badge>}</td>
                {can('admins.manage') && <td className="small">{m.email}</td>}
                <td>{m.manageable ? (
                  <select value={m.role_id} onChange={(e) => change.mutate({ userId: m.user_id, roleId: e.target.value })} aria-label={`${m.username} szerepköre`}>
                    {!assignable.some((r) => r.id === m.role_id) && <option value={m.role_id}>{m.role_name}</option>}
                    {assignable.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.level})</option>)}
                  </select>
                ) : <Badge tone="accent">{m.role_name}</Badge>}</td>
                <td>{m.totp_enabled ? <Badge tone="ok">bekapcsolva</Badge> : <Badge tone="warn">nincs</Badge>}</td>
                <td className="mono small">{m.identifiers.join(', ') || '–'}</td>
                <td className="small">{fmtRelative(m.last_login_at)}</td>
                <td className="actions">{m.manageable && <button className="btn sm danger" onClick={() => { if (window.confirm(`Eltávolítod ${m.username} hozzáférését?`)) remove.mutate(m.user_id); }}>Eltávolítás</button>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="card">
        <div className="card-head"><h2>Szerepkörök</h2>{can('roles.manage') && <button className="btn sm" onClick={() => setEditRole('new')}>+ Egyedi szerepkör</button>}</div>
        {roles.isLoading ? <Loading /> : roles.error ? <ErrorState error={roles.error} /> : roles.data!.items.length === 0 ? <Empty title="Nincs szerepkör" /> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Név</th><th className="num">Szint</th><th>Jogosultságok</th><th /></tr></thead>
            <tbody>{roles.data!.items.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b> {r.is_system ? <Badge>beépített</Badge> : <Badge tone="accent">egyedi</Badge>}</td>
                <td className="num">{r.level}</td>
                <td className="small">{r.permissions.length === perms.data?.items.length ? 'mind' : r.permissions.join(', ')}</td>
                <td className="actions">{!r.is_system && can('roles.manage') && r.level < server.role.level && <>
                  <button className="btn sm" onClick={() => setEditRole(r)}>Szerkesztés</button>
                  <button className="btn sm danger" onClick={() => { if (window.confirm(`Törlöd: ${r.name}?`)) void api('DELETE', `/servers/${server.id}/roles/${r.id}`).then(() => qc.invalidateQueries({ queryKey: ['roles', server.id] })).catch((e) => toast(e.message, 'error')); }}>Törlés</button>
                </>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <p className="muted small">Játékon belüli jogosultság: köss FiveM azonosítót a fiókodhoz (Profil oldal), vagy használj ACE-t: <code>add_ace group.admin milcsoguard.role.administrator allow</code>.</p>
      </section>
      {adding && (
        <Modal title="Admin hozzáadása" onClose={() => setAdding(false)} footer={<><button className="btn ghost" onClick={() => setAdding(false)}>Mégse</button><button className="btn primary" disabled={add.isPending || !form.email || !form.username || !form.roleId} onClick={() => add.mutate()}>Hozzáadás</button></>}>
          <p className="muted small">Ha az e-mail címhez még nincs fiók, létrejön egy ideiglenes jelszóval, amit első belépéskor kötelező lecserélni.</p>
          <label className="field"><span>E-mail</span><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="field"><span>Felhasználónév</span><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} pattern="[A-Za-z0-9_.\-]{2,32}" /></label>
          <label className="field"><span>Szerepkör</span><select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>{assignable.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.level})</option>)}</select></label>
          <FieldError error={add.error} />
        </Modal>
      )}
      {tempPw && (
        <Modal title="Ideiglenes jelszó" onClose={() => setTempPw(null)} footer={<button className="btn primary" onClick={() => setTempPw(null)}>Elmentettem</button>}>
          <p>Add át biztonságos csatornán. <b>Ez az egyetlen alkalom, amikor látható.</b></p>
          <pre className="json secret">{tempPw}</pre>
        </Modal>
      )}
      {editRole && perms.data && <RoleEditor role={editRole === 'new' ? null : editRole} perms={perms.data.items} onClose={() => setEditRole(null)} />}
    </>
  );
}
