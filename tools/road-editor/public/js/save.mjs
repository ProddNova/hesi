/**
 * Save workflow: deliberate save with diff, export/import, backup restore,
 * draft recovery, malformed-file recovery. Third module entry.
 */
import { toast, openModal, closeModal, setState, refreshSidebarBadges } from './app.mjs';
import { api } from './api.mjs';
import { state, syncPreviews } from './edit.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------------- init
function initSave() {
  $('btnSave').addEventListener('click', saveOverrides);
  $('btnMenu').addEventListener('click', openMenu);
  window.addEventListener('editor:key', (e) => {
    const { key, ctrl, ev } = e.detail;
    if (ctrl && (key === 's' || key === 'S')) { ev.preventDefault(); saveOverrides(); }
  });
  $('importFile').addEventListener('change', importFilePicked);
  maybeOfferDraft();
}
if (window.__stateReady) initSave();
else window.addEventListener('editor:stateReady', initSave, { once: true });

window.addEventListener('editor:overridesCorrupt', (e) => {
  const d = e.detail || {};
  openModal('⚠ File override danneggiato', `
    <p>Il file <code>route-overrides.json</code> non è utilizzabile:</p>
    <pre>${esc(d.error || 'errore sconosciuto')}</pre>
    <p>Il file <b>non è stato modificato</b> e verrà messo da parte come backup
    al prossimo salvataggio. Puoi ripristinare un backup precedente oppure
    continuare con un set vuoto.</p>`, [
    { label: 'Ripristina un backup…', onClick: () => { closeModal(); openBackups(); } },
    { label: 'Continua (set vuoto)', primary: true, onClick: () => closeModal() },
  ]);
});

// ---------------------------------------------------------- draft recovery
function maybeOfferDraft() {
  const draft = state.draftLoad();
  if (!draft) return;
  const current = JSON.stringify(state.doc);
  const draftJson = JSON.stringify(draft.doc);
  if (draftJson === current) return; // niente di nuovo nella bozza
  const editedRoutes = Object.keys((draft.doc && draft.doc.routes) || {});
  openModal('Bozza recuperata', `
    <p>È stata trovata una <b>bozza non salvata</b> (autosalvataggio del browser)
    del ${draft.at ? new Date(draft.at).toLocaleString('it-IT') : '—'}.</p>
    <p>Percorsi modificati nella bozza: <b>${editedRoutes.length ? editedRoutes.join(', ') : 'nessuno'}</b></p>
    <p>Vuoi riprenderla o scartarla e usare il file salvato sul disco?</p>`, [
    {
      label: 'Scarta bozza',
      onClick: () => { state.draftClear(); closeModal(); toast('Bozza scartata: uso il file salvato.'); },
    },
    {
      label: 'Riprendi la bozza',
      primary: true,
      onClick: () => {
        state.load(draft.doc, { asBaseline: false });
        closeModal();
        syncPreviews();
        toast('Bozza ripresa: ricordati di salvare.', 'warn');
      },
    },
  ]);
}

// -------------------------------------------------------------------- save
async function saveOverrides() {
  if (!state.dirty) { toast('Nessuna modifica da salvare.'); return; }
  setState('salvataggio…', true);
  try {
    const res = await api.save(state.doc);
    const before = res.previous || { version: 2, routes: {} };
    const after = JSON.parse(JSON.stringify(state.doc));
    state.markSaved();
    state.draftSave();
    refreshSidebarBadges();
    $('dirtyDot').hidden = true;
    $('sbDraft').textContent = '';
    showDiffModal('Override salvati ✓', before, after, `
      <p>Scritto in modo atomico su <code>${esc(res.path)}</code>
      ${res.backupPath ? `<br>Backup del file precedente: <code>${esc(res.backupPath)}</code>` : '<br>(primo salvataggio: nessun backup necessario)'}</p>`);
  } catch (e) {
    if (e.body && e.body.blocking) {
      const rows = e.body.blocking.map((b) => `<li><b>${esc(b.routeId)}</b><ul>${b.findings.map((f) => `<li>${esc(f.message)}</li>`).join('')}</ul></li>`).join('');
      openModal('⛔ Salvataggio bloccato', `
        <p>Ci sono <b>errori bloccanti</b>: correggili prima di salvare.</p>
        <ul>${rows}</ul>`, [{ label: 'Ho capito', primary: true, onClick: () => closeModal() }]);
    } else if (e.body && e.body.errors) {
      openModal('⛔ Schema non valido', `<pre>${esc(JSON.stringify(e.body.errors, null, 2))}</pre>`,
        [{ label: 'Chiudi', primary: true, onClick: () => closeModal() }]);
    } else {
      toast(`Salvataggio fallito: ${e.message}`, 'error', 8000);
    }
  } finally {
    setState('pronto', false);
  }
}

// ------------------------------------------------------------------- diff
export function computeDiff(before, after) {
  const bR = (before && before.routes) || {};
  const aR = (after && after.routes) || {};
  const lines = [];
  const ids = [...new Set([...Object.keys(bR), ...Object.keys(aR)])].sort();
  for (const id of ids) {
    const bOps = new Map((bR[id] || []).map((o) => [o.id || JSON.stringify(o), o]));
    const aOps = new Map((aR[id] || []).map((o) => [o.id || JSON.stringify(o), o]));
    const opLabel = (o) => `${o.op}${o.anchor && Number.isFinite(o.anchor.station) ? ` @${Math.round(o.anchor.station)}m` : ''}${o.note ? ` «${o.note}»` : ''}`;
    for (const [key, o] of aOps) {
      if (!bOps.has(key)) lines.push({ t: '+', routeId: id, text: `+ ${id}: ${opLabel(o)}` });
      else if (JSON.stringify(bOps.get(key)) !== JSON.stringify(o)) lines.push({ t: '~', routeId: id, text: `~ ${id}: ${opLabel(o)} (modificata)` });
    }
    for (const [key, o] of bOps) {
      if (!aOps.has(key)) lines.push({ t: '-', routeId: id, text: `- ${id}: ${opLabel(o)}` });
    }
  }
  return lines;
}

function showDiffModal(title, before, after, extraHtml = '') {
  const lines = computeDiff(before, after);
  const body = lines.length
    ? `<pre>${lines.map((l) => `<span class="${l.t === '-' ? 'diffDel' : l.t === '+' ? 'diffAdd' : ''}">${esc(l.text)}</span>`).join('\n')}</pre>`
    : '<p>Nessuna differenza a livello di operazioni.</p>';
  openModal(title, `${extraHtml}<h3>Differenze</h3>${body}`, [
    {
      label: 'Copia diff',
      onClick: () => {
        navigator.clipboard.writeText(lines.map((l) => l.text).join('\n') || '(nessuna differenza)');
        toast('Diff copiato negli appunti.');
      },
    },
    { label: 'Chiudi', primary: true, onClick: () => closeModal() },
  ]);
}

// -------------------------------------------------------------------- menu
function openMenu() {
  const menu = $('mapMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.innerHTML = '';
  const items = [
    ['💾 Salva override', saveOverrides],
    ['⬇ Esporta JSON…', exportJson],
    ['⬆ Importa JSON…', () => $('importFile').click()],
    ['🕘 Ripristina backup…', openBackups],
    ['📋 Copia diff non salvato', copyUnsavedDiff],
    ['🗑 Scarta bozza (torna al file salvato)', discardDraft],
  ];
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => { menu.hidden = true; fn(); });
    menu.appendChild(b);
  }
  const btn = $('btnMenu').getBoundingClientRect();
  const wrap = $('mapwrap').getBoundingClientRect();
  menu.style.left = `${Math.min(btn.left - wrap.left, wrap.width - 260)}px`;
  menu.style.top = '8px';
  menu.hidden = false;
  const closeOnce = (e) => { if (!menu.contains(e.target) && e.target !== $('btnMenu')) { menu.hidden = true; document.removeEventListener('mousedown', closeOnce); } };
  document.addEventListener('mousedown', closeOnce);
}

function exportJson() {
  const blob = new Blob([`${JSON.stringify(state.doc, null, 2)}\n`], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const t = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  a.download = `route-overrides-export-${t}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Override esportati.');
}

async function importFilePicked(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let doc;
  try {
    doc = JSON.parse(await file.text());
  } catch (err) {
    toast(`Il file non è JSON valido: ${err.message}`, 'error', 8000);
    return;
  }
  try {
    const v = await api.validateQuick(doc);
    if (v.schema && !v.schema.ok) {
      openModal('⛔ Import non valido', `<pre>${esc(JSON.stringify(v.schema.errors, null, 2))}</pre>`,
        [{ label: 'Chiudi', primary: true, onClick: () => closeModal() }]);
      return;
    }
  } catch (err) {
    toast(`Validazione dell'import fallita: ${err.message}`, 'error', 8000);
    return;
  }
  state.load(doc, { asBaseline: false }); // resta "non salvato" finché non salvi
  syncPreviews();
  toast(`Import riuscito: ${Object.keys((state.doc.routes) || {}).length} percorsi con modifiche. Ricordati di salvare.`, 'warn', 6000);
}

function discardDraft() {
  openModal('Scarta bozza', `
    <p>Tutte le modifiche <b>non salvate</b> verranno perse e l'editor tornerà
    al contenuto del file su disco. Continuare?</p>`, [
    { label: 'Annulla', onClick: () => closeModal() },
    {
      label: 'Scarta le modifiche',
      danger: true,
      onClick: async () => {
        closeModal();
        try {
          const ov = await api.overrides();
          state.load(ov.ok ? ov.doc : null);
          state.draftClear();
          syncPreviews();
          toast('Bozza scartata.');
        } catch (err) {
          toast(`Errore: ${err.message}`, 'error');
        }
      },
    },
  ]);
}

function copyUnsavedDiff() {
  const before = JSON.parse(state.baseline);
  const lines = computeDiff(before, state.doc);
  navigator.clipboard.writeText(lines.map((l) => l.text).join('\n') || '(nessuna differenza)');
  toast('Diff non salvato copiato negli appunti.');
}

// ----------------------------------------------------------------- backups
async function openBackups() {
  let res;
  try {
    res = await api.backups();
  } catch (e) {
    toast(`Impossibile leggere i backup: ${e.message}`, 'error');
    return;
  }
  if (!res.backups.length) {
    openModal('Backup', `<p>Nessun backup presente in <code>${esc(res.dir)}</code>.<br>
      I backup vengono creati automaticamente a ogni salvataggio.</p>`,
    [{ label: 'Chiudi', primary: true, onClick: () => closeModal() }]);
    return;
  }
  const rows = res.backups.map((b) => `
    <tr><td>${esc(b.name)}</td><td>${new Date(b.mtime).toLocaleString('it-IT')}</td>
    <td>${(b.size / 1024).toFixed(1)} kB</td>
    <td><button data-name="${esc(b.name)}">Ripristina</button></td></tr>`).join('');
  const { body } = openModal('Ripristina backup', `
    <p>Il ripristino sostituisce il file corrente (che viene a sua volta
    salvato come backup). Nessun dato va perso.</p>
    <table><tr><th>File</th><th>Data</th><th>Dimensione</th><th></th></tr>${rows}</table>`,
  [{ label: 'Chiudi', primary: true, onClick: () => closeModal() }]);
  body.querySelectorAll('button[data-name]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api.restore(btn.dataset.name);
        state.load(r.doc);
        state.draftClear();
        syncPreviews();
        closeModal();
        toast(`Backup ${btn.dataset.name} ripristinato.`);
      } catch (e) {
        toast(`Ripristino fallito: ${e.message}`, 'error', 8000);
        btn.disabled = false;
      }
    });
  });
}
