/**
 * Explicit actions (validation, temporary regeneration, gated apply) +
 * onboarding and keyboard help. Fourth module entry.
 */
import { app, toast, openModal, closeModal, setState } from './app.mjs';
import { api } from './api.mjs';
import { state } from './edit.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function initActions() {
  $('btnValidate').addEventListener('click', validateQuick);
  $('btnRegen').addEventListener('click', regeneratePreview);
  $('btnValidateFull').addEventListener('click', validateFull);
  $('btnApply').addEventListener('click', applyToWorkingTree);
  $('btnHelp').addEventListener('click', () => showHelp());
  window.addEventListener('editor:key', (e) => {
    if (e.detail.key === '?' || e.detail.key === 'h' || e.detail.key === 'H') showHelp();
  });
  if (!localStorage.getItem('roadEditor:onboarded')) showOnboarding();
}
if (window.__stateReady) initActions();
else window.addEventListener('editor:stateReady', initActions, { once: true });

// ------------------------------------------------------- quick validation
async function validateQuick() {
  setState('validazione rapida…', true);
  const { body } = openModal('Validazione rapida', '<p><span class="spin"></span> Controlli in corso su tutte le modifiche…</p>',
    [{ label: 'Chiudi', primary: true, onClick: () => closeModal() }]);
  try {
    const res = await api.validateQuick(state.doc);
    let html = '';
    if (res.schema && !res.schema.ok) {
      html += `<h3>⛔ Schema</h3><pre>${esc(JSON.stringify(res.schema.errors, null, 2))}</pre>`;
    } else {
      html += '<p>Schema JSON: ✓ valido</p>';
    }
    if (!res.routes.length) {
      html += '<p>Nessun percorso con modifiche: niente altro da controllare.</p>';
    }
    for (const r of res.routes) {
      const errs = r.findings.filter((f) => f.severity === 'error');
      const warns = r.findings.filter((f) => f.severity === 'warning');
      html += `<h3>${esc(r.routeId)} — ${errs.length ? `⛔ ${errs.length} errori` : '✓ nessun errore'}${warns.length ? ` · ⚠ ${warns.length} avvisi` : ''}</h3>`;
      if (r.stats && r.stats.devFromRaw) {
        html += `<p class="hint">deviazione max dall'OSM ${r.stats.devFromRaw.max.toFixed(2)} m · Δlunghezza ${r.stats.lenDelta.toFixed(1)} m</p>`;
      }
      if (r.findings.length) {
        html += `<ul>${r.findings.map((f) => `<li>${f.severity === 'error' ? '⛔' : '⚠'} ${esc(f.message)}</li>`).join('')}</ul>`;
      }
      for (const w of r.overrideWarnings || []) html += `<p>⚠ ${esc(w)}</p>`;
    }
    html += `<p class="hint">${res.ms} ms · controlli: schema, aggancio override, deviazione, auto-intersezione, zone protette, curvatura, incroci e distanze fra carreggiate</p>`;
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = `<p>⛔ Validazione fallita: ${esc(e.message)}</p>`;
  } finally {
    setState('pronto', false);
  }
}

// -------------------------------------------------- temporary regeneration
async function regeneratePreview() {
  setState('rigenerazione di anteprima…', true);
  const { body } = openModal('Rigenerazione di anteprima (file temporanei)',
    `<p><span class="spin"></span> Sto eseguendo l'INTERA pipeline di fairing con le
     modifiche correnti… (≈ 10 s)</p>
     <p class="hint">I file di produzione in <code>data/</code> non vengono toccati.</p>`,
    [{ label: 'Chiudi', primary: true, onClick: () => closeModal() }]);
  try {
    const res = await api.generatePreview(state.doc);
    const rows = res.changedRoutes.map((c) => `<tr><td>${esc(c.id)}</td><td>${c.maxDev ?? '—'} m</td><td>${c.lenDelta ?? '—'} m</td><td>${c.points}</td></tr>`).join('');
    body.innerHTML = `
      <p>${res.productionUntouched ? '✅ <b>Dati di produzione intatti</b> (hash verificati)' : '⛔ ATTENZIONE: i file di produzione risultano cambiati!'}</p>
      <p>Deviazione peggiore della rete: <b>${res.worstDev.v.toFixed(2)} m</b> su ${esc(res.worstDev.id)} · guardia distanze: ${res.guardRounds} round · ${res.ms} ms</p>
      <h3>Percorsi cambiati rispetto alla produzione (${res.changedRoutes.length})</h3>
      ${res.changedRoutes.length ? `<table><tr><th>percorso</th><th>maxDev</th><th>Δlunghezza</th><th>punti</th></tr>${rows}</table>` : '<p>Nessuno.</p>'}
      <h3>File temporanei generati</h3>
      <pre>${res.files.map(esc).join('\n')}</pre>
      <p class="hint">Per applicare davvero: salva gli override, poi esegui
      <code>node tools/build-smoothed-routes.mjs</code> (o l'azione «Applica» se abilitata) e controlla il diff con git.</p>`;
  } catch (e) {
    body.innerHTML = `<p>⛔ Rigenerazione fallita: ${esc(e.message)}</p>`;
  } finally {
    setState('pronto', false);
  }
}

// --------------------------------------------------------- full validation
async function validateFull() {
  const { body } = openModal('Validazione completa (sonde del progetto)',
    `<p>Esegue le sonde complete già presenti nel progetto (comandi fissi, sola
      lettura, possono richiedere minuti). Analizzano i dati ATTUALI di
      produzione, non le modifiche non applicate.</p><pre id="fullValOut"></pre>`,
    [{ label: 'Chiudi', primary: true, onClick: () => closeModal() }]);
  const out = body.querySelector('#fullValOut');
  setState('validazione completa…', true);
  try {
    await api.validateFull((chunk) => {
      out.textContent += chunk;
      out.scrollTop = out.scrollHeight;
    });
  } catch (e) {
    out.textContent += `\n⛔ interrotta: ${e.message}\n`;
  } finally {
    setState('pronto', false);
  }
}

// ------------------------------------------------------------ gated apply
function applyToWorkingTree() {
  if (!app.meta.allowApply) {
    toast('Azione disabilitata: riavvia il server con --allow-apply.', 'warn');
    return;
  }
  const { body } = openModal('Applica alla working tree', `
    <p>Questa azione:</p>
    <ul>
      <li>salva <code>data/route-overrides.json</code>;</li>
      <li>rigenera <code>data/routes-smoothed.json</code> e <code>.js</code> (con backup);</li>
      <li><b>non</b> esegue alcun commit.</li>
    </ul>
    <p>Scrivi <b>APPLICA</b> per confermare:</p>
    <input id="applyConfirm" type="text" placeholder="APPLICA">`, [
    { label: 'Annulla', onClick: () => closeModal() },
    {
      label: 'Applica',
      danger: true,
      onClick: async (btn) => {
        const val = body.querySelector('#applyConfirm').value.trim();
        if (val !== 'APPLICA') { toast('Conferma mancante.', 'warn'); return; }
        btn.disabled = true;
        try {
          const res = await api.apply(state.doc, 'APPLICA');
          state.markSaved();
          openModal('Applicato ✓', `
            <p>File aggiornati nella working tree:</p>
            <pre>${res.changedFiles.map(esc).join('\n')}</pre>
            <p>Percorsi rigenerati diversi da prima: ${res.changedRoutes.length}</p>
            <p class="hint">${esc(res.note)}</p>`,
          [{ label: 'Chiudi', primary: true, onClick: () => closeModal() }]);
        } catch (e) {
          toast(`Apply fallito: ${e.message}`, 'error', 9000);
          btn.disabled = false;
        }
      },
    },
  ]);
}

// ------------------------------------------------------------- onboarding
export function showOnboarding() {
  openModal('Benvenuto nell\'editor stradale', `
    <p>Correggi a mano le curve brutte della rete Shutoko. Le modifiche NON
    toccano i dati originali: finiscono in <code>route-overrides.json</code> e
    vengono applicate dalla pipeline di fairing offline.</p>
    <div class="ob-step"><b>1</b><div><b>Seleziona una strada</b> — cliccala sulla mappa o cercala nell'elenco a sinistra.</div></div>
    <div class="ob-step"><b>2</b><div><b>Zooma sulla curva difettosa</b> — rotella del mouse; l'overlay «Curvatura» aiuta a vederla.</div></div>
    <div class="ob-step"><b>3</b><div><b>Aggiungi 2–3 maniglie</b> — doppio clic sulla linea della strada.</div></div>
    <div class="ob-step"><b>4</b><div><b>Trascinale</b> in un arco ampio e fluido — la linea verde è l'anteprima del risultato REALE.</div></div>
    <div class="ob-step"><b>5</b><div><b>Controlla gli avvisi</b> nel pannello a destra: ⚠ è consentito, ⛔ blocca il salvataggio.</div></div>
    <div class="ob-step"><b>6</b><div><b>Salva l'override</b> — 💾 (Ctrl+S). Backup automatico, diff mostrato.</div></div>
    <div class="ob-step"><b>7</b><div><b>Rigenera anteprima</b> — l'intera rete su file temporanei, senza toccare la produzione.</div></div>
    <div class="ob-step"><b>8</b><div><b>Valida</b> — controlli rapidi o le sonde complete del progetto.</div></div>
    <p class="hint">Le zone viola sono protette (svincoli, raccordi, aree di servizio): l'editor le blocca per difesa della geometria del gioco.</p>`, [
    {
      label: 'Non mostrare più',
      onClick: () => { localStorage.setItem('roadEditor:onboarded', '1'); closeModal(); },
    },
    { label: 'Inizia!', primary: true, onClick: () => { localStorage.setItem('roadEditor:onboarded', '1'); closeModal(); } },
  ]);
}

// ------------------------------------------------------------------- help
export function showHelp() {
  openModal('Aiuto e scorciatoie', `
    <h3>Mappa</h3>
    <table>
      <tr><td><kbd>rotella</kbd></td><td>zoom centrato sul cursore</td></tr>
      <tr><td><kbd>trascina</kbd></td><td>sposta la vista</td></tr>
      <tr><td><kbd>A</kbd> / <kbd>F</kbd> / <kbd>G</kbd> / <kbd>0</kbd></td><td>adatta rete / percorso / sezione / reset</td></tr>
      <tr><td><kbd>+</kbd> <kbd>−</kbd> <kbd>frecce</kbd></td><td>zoom e pan da tastiera</td></tr>
      <tr><td><kbd>Esc</kbd></td><td>deseleziona / chiudi finestra</td></tr>
    </table>
    <h3>Modifica</h3>
    <table>
      <tr><td><kbd>doppio clic</kbd></td><td>aggiungi una maniglia sul percorso selezionato</td></tr>
      <tr><td><kbd>trascina maniglia</kbd></td><td>sposta (anteprima live)</td></tr>
      <tr><td><kbd>Shift+clic</kbd> / <kbd>Shift+trascina</kbd></td><td>selezione multipla / riquadro</td></tr>
      <tr><td><kbd>Canc</kbd></td><td>elimina le maniglie selezionate</td></tr>
      <tr><td><kbd>S</kbd></td><td>snap alla linea OSM / griglia 0,5 m</td></tr>
      <tr><td><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd></td><td>annulla / ripeti</td></tr>
      <tr><td><kbd>Ctrl+S</kbd></td><td>salva override</td></tr>
      <tr><td><kbd>n</kbd> / <kbd>N</kbd></td><td>avviso successivo / precedente</td></tr>
      <tr><td><kbd>?</kbd> o <kbd>H</kbd></td><td>questo aiuto</td></tr>
    </table>
    <h3>Legenda</h3>
    <table>
      <tr><td style="color:#98a2b3">— · —</td><td>Linea OSM grezza (con i punti originali)</td></tr>
      <tr><td style="color:#e5983c">——</td><td>Strada attuale (routes-smoothed in produzione)</td></tr>
      <tr><td style="color:#3ddc97">——</td><td>Anteprima modificata (fairing reale con i tuoi override)</td></tr>
      <tr><td style="color:#ffd23e">●</td><td>Maniglia manuale (anello = raggio di influenza)</td></tr>
      <tr><td style="color:#c084fc">▬</td><td>Zona protetta (svincoli, raccordi, PA) — bloccata</td></tr>
      <tr><td style="color:#f07878">◉</td><td>Curvatura: rosso = sinistra, blu = destra; più acceso = più stretta</td></tr>
    </table>`, [
    { label: 'Mostra di nuovo il tutorial', onClick: () => { closeModal(); showOnboarding(); } },
    { label: 'Chiudi', primary: true, onClick: () => closeModal() },
  ]);
}
