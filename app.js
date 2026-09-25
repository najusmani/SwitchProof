'use strict';

const $ = (id) => document.getElementById(id);

// Per-viewer conveniences only (theme, last type, message defaults).
const store = {
  get(k, d) { try { const v = localStorage.getItem('ss.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('ss.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Reference data ----------
const ICONS = {
  atm: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M7 9v6M17 9v6"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19M6 15h4"/>',
  transfer: '<path d="M4 8h15l-3.5-3.5M20 16H5l3.5 3.5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>',
  refund: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  deposit: '<path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 20h16"/>',
};

const COL_LABELS = { from: 'from_account', to: 'to_account', amount: 'amount', currency: 'currency' };

const TYPES = [
  { id: 'WITHDRAWAL', name: 'ATM Withdrawal', code: '0200 · 010000', icon: 'atm', cols: ['from', 'amount', 'currency'] },
  { id: 'PURCHASE', name: 'POS Purchase', code: '0100 · 000000', icon: 'card', cols: ['from', 'amount', 'currency'] },
  { id: 'TRANSFER', name: 'Account Transfer', code: '0200 · 400020', icon: 'transfer', cols: ['from', 'to', 'amount', 'currency'] },
  { id: 'BALANCE_INQUIRY', name: 'Balance Inquiry', code: '0200 · 310000', icon: 'eye', cols: ['from'] },
  { id: 'SIGNON', name: 'Sign On', code: '0800 · 301', icon: 'power', cols: [] },
  { id: 'REFUND', name: 'Refund', code: '0200 · 200000', icon: 'refund', cols: ['from', 'amount', 'currency'], tag: 'Unverified' },
  { id: 'CASH_DEPOSIT', name: 'Cash Deposit', code: '0200 · 210000', icon: 'deposit', cols: ['from', 'amount', 'currency'], tag: 'Unverified' },
];
const typeById = (id) => TYPES.find(t => t.id === id) || TYPES[0];

const TEMPLATES = {
  TRANSFER: 'from_account,to_account,amount,currency\n000100000001,000100000002,9.00,XCD\n000100000001,000100000002,12.50,951\n',
  WITHDRAWAL: 'from_account,amount,currency\n000100000001,20.00,XCD\n000100000002,15.00,USD\n',
  PURCHASE: 'from_account,amount,currency\n000100000001,18.00,XCD\n000100000002,25.00,USD\n',
  REFUND: 'from_account,amount,currency\n000100000001,5.00,XCD\n',
  CASH_DEPOSIT: 'from_account,amount,currency\n000100000001,50.00,XCD\n',
  BALANCE_INQUIRY: 'from_account\n000100000001\n000100000002\n',
};

// ISO 4217 alpha -> numeric, for the currencies this bank sees most.
const CCY = { XCD: '951', USD: '840', EUR: '978', GBP: '826', CAD: '124', TTD: '780', BBD: '052', JMD: '388', INR: '356' };
const CCY_ALPHA = Object.fromEntries(Object.entries(CCY).map(([a, n]) => [n, a]));
function resolveCcy(v) {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (!s) return null;
  if (/^\d{3}$/.test(s)) return s;
  return CCY[s] || undefined; // undefined = unrecognised
}
const ccyLabel = (n) => (n ? (CCY_ALPHA[n] ? CCY_ALPHA[n] + ' ' + n : n) : '');

const CODE_DESC = {
  '00': 'Approved', '04': 'Pick-up', '05': 'Do not honor', '06': 'Error', '12': 'Invalid transaction',
  '13': 'Invalid amount', '14': 'Invalid card number', '15': 'No such issuer', '30': 'Format error',
  '39': 'No credit account', '51': 'Not sufficient funds', '52': 'No checking account', '53': 'No savings account',
  '54': 'Expired card', '55': 'Incorrect PIN', '56': 'No card record', '57': 'Not permitted to cardholder',
  '58': 'Not permitted to terminal', '61': 'Exceeds withdrawal limit', '91': 'Issuer or switch inoperative',
  '92': 'No routing available', '94': 'Duplicate transmission', '96': 'System malfunction',
  'MTI:0810': 'Network response (0810)', 'NO_RESPONSE': 'No response',
};
const codeClass = (c) => (c === '00' || c === 'MTI:0810') ? 'ok' : (c === 'NO_RESPONSE' || String(c).startsWith('MTI:')) ? 'warn' : 'bad';

// ---------- State ----------
let currentType = typeById(store.get('type', 'TRANSFER'));
const dataText = {};          // raw rows text per type, so switching types doesn't garble data
let parsed = [];              // rows parsed for the current type
let currentJobId = null;
let pollTimer = null;
let series = [];              // chart points {t, tps, lat}
let lastPoll = null;

// ---------- Toasts ----------
function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function showError(msg) { const b = $('errorBox'); b.textContent = msg; b.hidden = false; }
function clearError() { $('errorBox').hidden = true; }

// ---------- Theme ----------
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  drawChart();
}
applyTheme(store.get('theme', null));
$('themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme')
    || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'light' ? 'dark' : 'light';
  store.set('theme', next);
  applyTheme(next);
});

// ---------- Switch targets ----------
let targetsState = { active: null, targets: [] };
const targetTests = {};   // id -> {ok, text}
const activeTarget = () => targetsState.targets.find(t => t.id === targetsState.active) || targetsState.targets[0] || null;
const targetLabel = (t) => (t ? `${t.name} (${t.host}:${t.port})` : '—');

async function targetsApi(path, body) {
  const res = await apiFetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadTargets() {
  try { targetsState = await targetsApi('/api/targets'); renderTargets(); } catch (e) { /* shown via conn indicator */ }
}

function renderTargets() {
  const t = activeTarget();
  $('targetName').textContent = t ? t.name : '—';
  $('targetAddr').textContent = t ? `${t.host}:${t.port}` : '';
  $('targetList').innerHTML = targetsState.targets.map(x => {
    const st = targetTests[x.id];
    return `<li class="t-item ${x.id === targetsState.active ? 'active' : ''}" data-id="${escapeHtml(x.id)}" title="Use this target">
      <span class="t-radio"></span>
      <span class="t-main"><div class="t-name">${escapeHtml(x.name)}</div><div class="t-addr">${escapeHtml(x.host)}:${x.port}</div></span>
      ${st ? `<span class="t-status ${st.ok ? 'ok' : 'bad'}">${escapeHtml(st.text)}</span>` : ''}
      <span class="t-actions">
        <button type="button" class="t-btn" data-act="test" title="Test TCP connection"><svg viewBox="0 0 24 24"><path d="M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0"/><circle cx="12" cy="16" r="1.5"/></svg></button>
        <button type="button" class="t-btn" data-act="edit" title="Edit"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg></button>
        <button type="button" class="t-btn del" data-act="del" title="Remove"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>
      </span>
    </li>`;
  }).join('');
  fillTargetDefaults(false);
  refreshSummaries();
  if (typeof renderUatTarget === 'function') renderUatTarget();
}

function openTargets(open) {
  $('targetPop').hidden = !open;
  $('targetBtn').setAttribute('aria-expanded', String(open));
}
$('targetBtn').addEventListener('click', () => openTargets($('targetPop').hidden));
document.addEventListener('click', (e) => {
  if (!$('targetPop').hidden && !e.target.closest('.target-wrap')) openTargets(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openTargets(false); });

async function testTarget(body, onDone) {
  try {
    const d = await targetsApi('/api/targets/test', body);
    onDone(d.ok ? { ok: true, text: `reachable · ${d.ms}ms` } : { ok: false, text: d.error || 'unreachable' });
  } catch (e) { onDone({ ok: false, text: e.message }); }
}

$('targetList').addEventListener('click', async (e) => {
  const li = e.target.closest('.t-item');
  if (!li) return;
  const id = li.dataset.id;
  const act = e.target.closest('.t-btn') ? e.target.closest('.t-btn').dataset.act : 'select';
  const t = targetsState.targets.find(x => x.id === id);
  try {
    if (act === 'select') {
      if (id === targetsState.active) return;
      targetsState = await targetsApi('/api/targets/active', { id });
      renderTargets();
      toast(`Now sending to ${targetLabel(t)}`, 'ok');
    } else if (act === 'test') {
      targetTests[id] = { ok: true, text: 'testing…' };
      renderTargets();
      await testTarget({ id }, (r) => { targetTests[id] = r; renderTargets(); });
    } else if (act === 'edit') {
      $('tfId').value = t.id; $('tfName').value = t.name; $('tfHost').value = t.host; $('tfPort').value = t.port;
      $('tfTitle').textContent = `Edit ${t.name}`; $('tfSave').textContent = 'Save changes'; $('tfCancel').hidden = false;
      $('tfMsg').textContent = ''; $('tfHost').focus();
    } else if (act === 'del') {
      if (!confirm(`Remove target ${targetLabel(t)}?`)) return;
      targetsState = await targetsApi('/api/targets/delete', { id });
      delete targetTests[id];
      renderTargets();
    }
  } catch (err) { toast(err.message, 'bad'); }
});

function resetTargetForm() {
  $('targetForm').reset(); $('tfId').value = '';
  $('tfTitle').textContent = 'Add a target'; $('tfSave').textContent = 'Add target'; $('tfCancel').hidden = true;
}
$('tfCancel').addEventListener('click', () => { resetTargetForm(); $('tfMsg').textContent = ''; });
$('tfTest').addEventListener('click', () => {
  const msg = $('tfMsg');
  msg.className = 'tf-msg'; msg.textContent = 'testing…';
  testTarget({ host: $('tfHost').value.trim(), port: $('tfPort').value }, (r) => { msg.className = 'tf-msg ' + (r.ok ? 'ok' : 'bad'); msg.textContent = r.text; });
});
$('targetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const editing = !!$('tfId').value;
  const body = { id: $('tfId').value || null, name: $('tfName').value.trim() || null, host: $('tfHost').value.trim(), port: $('tfPort').value };
  try {
    targetsState = await targetsApi('/api/targets', body);
    renderTargets();
    resetTargetForm();
    $('tfMsg').className = 'tf-msg ok'; $('tfMsg').textContent = editing ? 'saved' : 'added — click it above to use it';
  } catch (err) {
    $('tfMsg').className = 'tf-msg bad'; $('tfMsg').textContent = err.message;
  }
});

// ---------- Type tiles ----------
function renderTypes() {
  $('typeGrid').innerHTML = TYPES.map(t => `
    <button type="button" class="type-tile" role="radio" data-type="${t.id}" aria-checked="${t.id === currentType.id}">
      <span class="type-ico"><svg viewBox="0 0 24 24">${ICONS[t.icon]}</svg></span>
      <span><span class="type-name">${t.name}</span><span class="type-code">${t.code}</span>${t.tag ? `<span class="type-tag">${t.tag}</span>` : ''}</span>
    </button>`).join('');
}
$('typeGrid').addEventListener('click', (e) => {
  const tile = e.target.closest('.type-tile');
  if (!tile) return;
  dataText[currentType.id] = $('rowsText').value;
  currentType = typeById(tile.dataset.type);
  store.set('type', currentType.id);
  renderTypes();
  onTypeChanged();
});

function onTypeChanged() {
  const hasData = currentType.cols.length > 0;
  $('dataArea').hidden = !hasData;
  $('noDataNote').hidden = hasData;
  $('templateBtn').hidden = !hasData;
  $('formatCols').innerHTML = currentType.cols.map((c, i) =>
    (i ? '<span class="col-sep">,</span>' : '') +
    `<span class="col-chip ${c === 'from' || c === 'to' ? 'req' : ''}">${COL_LABELS[c]}</span>`).join('');
  $('rowsText').placeholder = (TEMPLATES[currentType.id] || '').trim();
  $('rowsText').value = dataText[currentType.id] || '';
  $('drop').classList.toggle('loaded', !!$('rowsText').value.trim());
  reparse();
}

// ---------- CSV parsing ----------
const ALIASES = {
  from: ['from', 'from_account', 'fromaccount', 'from_acc', 'account', 'account_no', 'debit_account', 'source'],
  to: ['to', 'to_account', 'toaccount', 'to_acc', 'credit_account', 'destination', 'beneficiary'],
  amount: ['amount', 'amt', 'txn_amount', 'value'],
  currency: ['currency', 'ccy', 'currency_code', 'cur'],
};
const norm = (s) => s.toLowerCase().replace(/[\s-]+/g, '_');

function splitLine(line, delim) {
  return line.split(delim).map(c => c.trim().replace(/^"(.*)"$/, '$1').trim());
}

function parseRows(text, type) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  if (!lines.length || !type.cols.length) return [];
  const delim = ['\t', ';', '|', ','].find(d => lines[0].includes(d)) || ',';
  let cells = lines.map(l => splitLine(l, delim));

  // Header row: map columns by name. No header: columns are positional in the type's format.
  let idx = {};
  const head = cells[0].map(norm);
  const isHeader = head.some(h => Object.values(ALIASES).some(a => a.includes(h)));
  if (isHeader) {
    for (const col of type.cols) idx[col] = head.findIndex(h => ALIASES[col].includes(h));
    cells = cells.slice(1);
  } else {
    type.cols.forEach((col, i) => { idx[col] = i; });
  }
  const pick = (row, col) => (idx[col] != null && idx[col] >= 0 ? (row[idx[col]] || '') : '');

  return cells.map((row, i) => {
    const r = { line: i + 1, from: pick(row, 'from'), to: pick(row, 'to'), amount: pick(row, 'amount').replace(/,/g, ''), currencyRaw: pick(row, 'currency'), errors: [] };
    if (!r.from) r.errors.push('missing from_account');
    else if (!/^[A-Za-z0-9]{4,}$/.test(r.from)) r.errors.push('bad from_account');
    if (type.cols.includes('to')) {
      if (!r.to) r.errors.push('missing to_account');
      else if (!/^[A-Za-z0-9]{4,}$/.test(r.to)) r.errors.push('bad to_account');
      else if (r.to === r.from) r.errors.push('to = from');
    }
    if (type.cols.includes('amount') && r.amount) {
      const n = Number(r.amount);
      if (!isFinite(n) || n <= 0) r.errors.push('bad amount');
    }
    if (type.cols.includes('currency')) {
      r.currency = resolveCcy(r.currencyRaw);
      if (r.currency === undefined) r.errors.push('unknown currency ' + r.currencyRaw);
    }
    return r;
  });
}

let parseTimer = null;
$('rowsText').addEventListener('input', () => { clearTimeout(parseTimer); parseTimer = setTimeout(reparse, 180); });

function reparse() {
  dataText[currentType.id] = $('rowsText').value;
  parsed = parseRows($('rowsText').value, currentType);
  renderPreview();
  refreshSummaries();
}

function validRows() { return parsed.filter(r => !r.errors.length); }

function renderPreview() {
  const box = $('preview');
  if (!parsed.length) { box.hidden = true; return; }
  box.hidden = false;
  const valid = validRows();
  const bad = parsed.length - valid.length;
  $('validCount').textContent = valid.length + ' valid';
  $('invalidCount').hidden = !bad;
  $('invalidCount').textContent = bad + ' invalid';

  // Totals by currency, so it's clear how much money a run moves.
  const totals = {};
  if (currentType.cols.includes('amount')) {
    const defAmt = Number($('amount').value) || 0;
    const defCcy = resolveCcy($('currencyCode').value) || $('currencyCode').value;
    for (const r of valid) {
      const c = r.currency || defCcy;
      totals[c] = (totals[c] || 0) + (r.amount ? Number(r.amount) : defAmt);
    }
  }
  $('totalsLine').textContent = Object.entries(totals).map(([c, v]) => `${v.toFixed(2)} ${CCY_ALPHA[c] || c}`).join(' · ');

  const cols = currentType.cols;
  $('previewHead').innerHTML = '<tr><th>#</th>' + cols.map(c => `<th class="${c === 'amount' ? 'num' : ''}">${COL_LABELS[c]}</th>`).join('') + '<th>Status</th></tr>';
  const shown = parsed.slice(0, 200);
  $('previewBody').innerHTML = shown.map(r => {
    const cells = cols.map(c => {
      if (c === 'amount') return `<td class="num">${r.amount ? escapeHtml(Number(r.amount).toFixed(2)) : '<span class="muted">default</span>'}</td>`;
      if (c === 'currency') return `<td>${r.currencyRaw ? escapeHtml(r.currency ? ccyLabel(r.currency) : r.currencyRaw) : '<span class="muted">default</span>'}</td>`;
      return `<td>${escapeHtml(r[c])}</td>`;
    }).join('');
    const status = r.errors.length ? `<td class="reason">${escapeHtml(r.errors.join(', '))}</td>` : '<td><span class="pill ok">ok</span></td>';
    return `<tr class="${r.errors.length ? 'row-bad' : ''}"><td class="muted">${r.line}</td>${cells}${status}</tr>`;
  }).join('') + (parsed.length > shown.length ? `<tr><td colspan="${cols.length + 2}" class="muted small">+ ${parsed.length - shown.length} more rows</td></tr>` : '');
}

// File upload / drag and drop
function loadFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('rowsText').value = reader.result;
    $('drop').classList.add('loaded');
    $('dropSub').textContent = file.name + ' · ' + Math.max(1, Math.round(file.size / 1024)) + ' KB';
    reparse();
    toast(`Loaded ${validRows().length} rows from ${file.name}`, 'ok');
  };
  reader.readAsText(file);
}
$('fileInput').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
['dragenter', 'dragover'].forEach(ev => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('drag'); }));
['dragleave', 'drop'].forEach(ev => $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('drag'); }));
$('drop').addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

$('clearBtn').addEventListener('click', () => {
  $('rowsText').value = '';
  $('drop').classList.remove('loaded');
  $('dropSub').textContent = 'Header row optional · comma, semicolon or tab separated';
  reparse();
});

$('templateBtn').addEventListener('click', () => {
  const csv = TEMPLATES[currentType.id];
  if (!csv) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = currentType.id.toLowerCase() + '_template.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- Load profile & summaries ----------
// Browser-local: amount and rotating PANs. Per target (targets.json): terminal, institutions, currency, card.
const LOCAL_FIELDS = ['amount', 'pansText'];
const TARGET_FIELDS = ['terminalId', 'acquiringInstitution', 'forwardingInstitution', 'currencyCode', 'pan', 'remoteAcquirer'];
const BUILTIN_DEFAULTS = { terminalId: 'ATM1', acquiringInstitution: '100001', forwardingInstitution: '', currencyCode: '951', pan: '4000000000000002', remoteAcquirer: '' };
const savedDefaults = store.get('defaults', null);
if (savedDefaults) LOCAL_FIELDS.forEach(f => { if (savedDefaults[f] != null) $(f).value = savedDefaults[f]; });
LOCAL_FIELDS.forEach(f => $(f).addEventListener('input', () => {
  store.set('defaults', Object.fromEntries(LOCAL_FIELDS.map(k => [k, $(k).value])));
  refreshSummaries();
  if (f === 'amount') renderPreview();
}));

let filledFor = null;       // target whose defaults are currently in the fields
let saveDefaultsTimer = null;
function fillTargetDefaults(force) {
  const t = activeTarget();
  if (!t || (!force && filledFor === t.id)) return;
  filledFor = t.id;
  const d = t.defaults || {};
  TARGET_FIELDS.forEach(f => { $(f).value = d[f] != null ? d[f] : BUILTIN_DEFAULTS[f]; });
  $('defaultsTarget').textContent = t.name;
  $('defaultsSaved').textContent = '';
  renderPreview();
}
TARGET_FIELDS.forEach(f => $(f).addEventListener('input', () => {
  refreshSummaries();
  if (f === 'currencyCode') renderPreview();
  const id = filledFor;
  clearTimeout(saveDefaultsTimer);
  $('defaultsSaved').className = 'saved-note'; $('defaultsSaved').textContent = 'saving…';
  saveDefaultsTimer = setTimeout(async () => {
    const defaults = Object.fromEntries(TARGET_FIELDS.map(k => [k, $(k).value.trim()]));
    const ccy = resolveCcy(defaults.currencyCode);
    if (ccy) defaults.currencyCode = ccy;
    try {
      targetsState = await targetsApi('/api/targets/defaults', { id, defaults });
      $('defaultsSaved').className = 'saved-note ok';
      $('defaultsSaved').textContent = `saved for ${(targetsState.targets.find(x => x.id === id) || {}).name || id}`;
      renderTargets();
    } catch (e) { $('defaultsSaved').className = 'saved-note bad'; $('defaultsSaved').textContent = e.message; }
  }, 600);
}));
['count', 'duration', 'concurrency'].forEach(f => $(f).addEventListener('input', refreshSummaries));
$('matchRows').addEventListener('change', refreshSummaries);

function refreshSummaries() {
  const n = validRows().length;
  const usesData = currentType.cols.length > 0;
  const match = $('matchRows').checked && usesData && n > 0;
  if (match) $('count').value = n;
  $('count').disabled = match;
  $('matchHint').textContent = usesData ? (n ? `(${n} rows)` : '(no rows yet)') : '';
  $('matchRows').closest('.switch').style.display = usesData ? '' : 'none';

  const count = Number($('count').value) || 0;
  const dur = Number($('duration').value) || 0;
  $('tpsHint').textContent = dur > 0 ? `≈ ${(count / dur).toFixed(count / dur < 10 ? 1 : 0)} tx/s` : 'burst';

  const acq = $('acquiringInstitution').value || '—';
  $('defaultsSummary').textContent = `${acq} · ${$('terminalId').value || '—'} · ${ccyLabel(resolveCcy($('currencyCode').value)) || $('currencyCode').value}`;

  const rowsPart = usesData ? (n ? ` · cycling ${n} row${n > 1 ? 's' : ''}` : ' · <span style="color:var(--bad)">no data rows</span>') : '';
  const t = activeTarget();
  $('fireSummary').innerHTML = `<b>${currentType.name}</b> → ${escapeHtml(t ? t.name : '—')}<br>${count} tx over ${dur || 0}s · ${$('concurrency').value || 1} parallel${rowsPart}`;
}

// ---------- Run ----------
$('startBtn').addEventListener('click', async () => {
  clearError();
  const usesData = currentType.cols.length > 0;
  const rows = validRows();
  if (usesData && !rows.length) {
    showError(`Add at least one valid row (${currentType.cols.map(c => COL_LABELS[c]).join(', ')}).`);
    return;
  }
  const defCcy = resolveCcy($('currencyCode').value);
  if (!defCcy) { showError('Default currency is not recognised. Use a 3-digit code (951) or XCD / USD.'); return; }
  const skipped = parsed.length - rows.length;

  const payload = {
    type: currentType.id,
    count: Number($('count').value) || 1,
    durationSeconds: Number($('duration').value) || 0,
    concurrency: Number($('concurrency').value) || 1,
    amount: $('amount').value,
    currencyCode: defCcy,
    terminalId: $('terminalId').value,
    acquiringInstitution: $('acquiringInstitution').value,
    forwardingInstitution: $('forwardingInstitution').value,
    pan: $('pan').value,
    pans: $('pansText').value.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean),
    rows: rows.map(r => ({ from: r.from, to: r.to || null, amount: r.amount || null, currency: r.currency || null })),
    targetId: targetsState.active,
  };

  try {
    const res = await apiFetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) { showError(data.error || 'Failed to start test'); return; }
    currentJobId = data.jobId;
    $('startBtn').disabled = true;
    $('cancelBtn').disabled = false;
    $('runTitle').textContent = `${currentType.name} · ${payload.count} tx → ${data.target || ''}`;
    setStatus('running', 'Running');
    resetMonitor();
    if (skipped) toast(`${skipped} invalid row${skipped > 1 ? 's' : ''} skipped`, 'bad');
    pollTimer = setInterval(poll, 400);
  } catch (e) {
    showError('Could not reach the local server: ' + e);
  }
});

$('cancelBtn').addEventListener('click', async () => {
  if (!currentJobId) return;
  await apiFetch('/api/cancel?id=' + encodeURIComponent(currentJobId), { method: 'POST' });
});

function setStatus(cls, text) { const p = $('statusPill'); p.className = 'status ' + cls; p.textContent = text; }

function resetMonitor() {
  ['stSent', 'stCompleted', 'stApproved', 'stDeclined', 'stErrors', 'stThroughput', 'stAvgLatency'].forEach(id => $(id).textContent = '0');
  $('stMinMax').textContent = '0 / 0';
  $('progressFill').style.width = '0%';
  $('progressText').textContent = 'starting…';
  $('codeBars').innerHTML = '<div class="muted small">No responses yet</div>';
  $('resultsTableBody').innerHTML = '<tr><td colspan="8" class="muted small">Waiting for responses…</td></tr>';
  $('errorList').innerHTML = '<li class="muted small">None</li>';
  series = [];
  lastPoll = null;
  drawChart();
}

async function poll() {
  if (!currentJobId) return;
  let d;
  try {
    const res = await apiFetch('/api/status?id=' + encodeURIComponent(currentJobId));
    d = await res.json();
  } catch (e) { return; }

  $('stSent').textContent = d.sent;
  $('stCompleted').textContent = d.completed;
  $('stApproved').textContent = d.approved;
  $('stDeclined').textContent = d.declined;
  $('stErrors').textContent = d.errors;
  $('stThroughput').textContent = d.throughputPerSec;
  $('stAvgLatency').textContent = d.avgLatencyMs;
  $('stMinMax').textContent = d.minLatencyMs + ' / ' + d.maxLatencyMs;

  const pct = d.count > 0 ? Math.min(100, Math.round(d.completed / d.count * 100)) : 0;
  $('progressFill').style.width = pct + '%';
  $('progressText').textContent = `${d.completed} / ${d.count} completed · ${pct}% · ${(d.elapsedMs / 1000).toFixed(1)}s`;

  // Chart: instantaneous throughput from completed deltas, cumulative average latency.
  const now = d.elapsedMs;
  if (lastPoll && now > lastPoll.t) {
    const tps = (d.completed - lastPoll.completed) / ((now - lastPoll.t) / 1000);
    series.push({ t: now, tps: Math.max(0, tps), lat: d.avgLatencyMs });
  } else if (!lastPoll) {
    series.push({ t: now, tps: 0, lat: d.avgLatencyMs });
  }
  lastPoll = { t: now, completed: d.completed };
  drawChart();

  renderCodes(d.responseCodeCounts || {}, d.completed);
  renderResults(d.recentResults || []);

  const errors = d.recentErrors || [];
  $('errorList').innerHTML = errors.length
    ? errors.slice().reverse().map(e => `<li>${escapeHtml(e)}</li>`).join('')
    : '<li class="muted small">None</li>';

  if (d.status === 'DONE' || d.status === 'CANCELLED') {
    clearInterval(pollTimer);
    pollTimer = null;
    $('startBtn').disabled = false;
    $('cancelBtn').disabled = true;
    setStatus(d.status === 'DONE' ? 'done' : 'cancelled', d.status === 'DONE' ? 'Done' : 'Cancelled');
    toast(`${currentType.name}: ${d.approved} approved, ${d.declined} declined, ${d.errors} errors`, d.declined || d.errors ? 'bad' : 'ok');
    loadAuthorizations();
  }
}

function renderCodes(counts, total) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { $('codeBars').innerHTML = '<div class="muted small">No responses yet</div>'; return; }
  const max = Math.max(...entries.map(e => e[1]));
  $('codeBars').innerHTML = entries.map(([code, n]) => {
    const cls = codeClass(code);
    const label = code.startsWith('MTI:') ? code.slice(4) : code === 'NO_RESPONSE' ? '—' : code;
    const pct = total ? Math.round(n / total * 100) : 0;
    return `<div class="code-row">
      <span class="code-badge ${cls}">${escapeHtml(label)}</span>
      <div class="code-main">
        <div class="code-desc">${escapeHtml(CODE_DESC[code] || 'Response ' + code)}</div>
        <div class="code-track"><div class="code-fill ${cls}" style="width:${Math.max(2, n / max * 100)}%"></div></div>
      </div>
      <span class="code-count">${n} · ${pct}%</span>
    </div>`;
  }).join('');
}

function renderResults(rows) {
  if (!rows.length) return;
  $('resultsTableBody').innerHTML = rows.slice(-200).reverse().map(r => {
    const code = r.responseCode || (r.mti ? 'MTI:' + r.mti : 'NO_RESPONSE');
    const cls = r.ok ? 'ok' : codeClass(code);
    const label = r.responseCode || r.mti || '—';
    return `<tr>
      <td class="muted">${r.index + 1}</td>
      <td>${escapeHtml(r.rrn || '')}</td>
      <td>${escapeHtml(r.fromAccount || '')}</td>
      <td>${escapeHtml(r.toAccount || '')}</td>
      <td class="num">${r.amount ? escapeHtml(Number(r.amount).toFixed(2)) : ''}</td>
      <td class="ccy">${escapeHtml(CCY_ALPHA[r.currencyCode] || r.currencyCode || '')}</td>
      <td><span class="pill ${cls} code" title="${escapeHtml(CODE_DESC[code] || '')}">${escapeHtml(label)} ${escapeHtml(r.ok ? 'approved' : (CODE_DESC[code] || 'declined').toLowerCase())}</span></td>
      <td class="num">${r.latencyMs}</td>
    </tr>`;
  }).join('');
}

// ---------- Chart ----------
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function drawChart() {
  const canvas = $('chart');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  $('chartEmpty').hidden = series.length > 1;
  if (series.length < 2) return;

  const pad = { l: 38, r: 44, t: 10, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const tMax = series[series.length - 1].t || 1;
  const tpsMax = Math.max(1, ...series.map(p => p.tps)) * 1.15;
  const latMax = Math.max(1, ...series.map(p => p.lat)) * 1.15;
  const x = (t) => pad.l + (t / tMax) * iw;
  const yT = (v) => pad.t + ih - (v / tpsMax) * ih;
  const yL = (v) => pad.t + ih - (v / latMax) * ih;

  const border = cssVar('--border'), muted = cssVar('--muted'), accent = cssVar('--accent'), warn = cssVar('--warn');
  ctx.font = '11px ' + cssVar('--mono');
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (ih / 3) * i;
    ctx.strokeStyle = border; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = muted;
    ctx.textAlign = 'right'; ctx.fillText((tpsMax * (1 - i / 3)).toFixed(tpsMax < 10 ? 1 : 0), pad.l - 6, y + 4);
    ctx.textAlign = 'left'; ctx.fillText(Math.round(latMax * (1 - i / 3)), W - pad.r + 6, y + 4);
  }
  ctx.textAlign = 'center';
  ctx.fillText('0s', pad.l, H - 5);
  ctx.fillText((tMax / 1000).toFixed(1) + 's', W - pad.r, H - 5);

  // Throughput area
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ih);
  grad.addColorStop(0, accent + '2e');
  grad.addColorStop(1, accent + '00');
  ctx.beginPath();
  ctx.moveTo(x(series[0].t), pad.t + ih);
  series.forEach(p => ctx.lineTo(x(p.t), yT(p.tps)));
  ctx.lineTo(x(tMax), pad.t + ih);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  series.forEach((p, i) => i ? ctx.lineTo(x(p.t), yT(p.tps)) : ctx.moveTo(x(p.t), yT(p.tps)));
  ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();

  // Latency line
  ctx.beginPath();
  series.forEach((p, i) => i ? ctx.lineTo(x(p.t), yL(p.lat)) : ctx.moveTo(x(p.t), yL(p.lat)));
  ctx.strokeStyle = warn; ctx.lineWidth = 1.75; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
}
window.addEventListener('resize', drawChart);

// ---------- Open transactions ----------
const settleEdits = {};   // rrn -> amount typed by the user; survives the periodic refresh
document.addEventListener('input', (e) => {
  if (e.target.classList.contains('settle')) settleEdits[e.target.closest('tr').dataset.rrn] = e.target.value;
});

async function loadAuthorizations() {
  let data;
  try {
    const res = await apiFetch('/api/authorizations');
    data = await res.json();
    setConn(true);
  } catch (e) { setConn(false); return; }
  const rows = data.authorizations || [];
  $('authCount').textContent = rows.length + ' open';
  if (!rows.length) {
    $('authTableBody').innerHTML = '<tr><td colspan="10" class="muted small">No open transactions — approved Purchases, Withdrawals and Transfers appear here.</td></tr>';
    return;
  }
  // Keep in-progress rows (buttons disabled / result shown) untouched between refreshes.
  const busy = new Set([...document.querySelectorAll('#authTableBody tr[data-busy]')].map(tr => tr.dataset.rrn));
  if (busy.size) return;
  // Don't rebuild the table under the user's cursor while they're typing a settle amount.
  if (document.activeElement && document.activeElement.classList.contains('settle')) return;
  $('authTableBody').innerHTML = rows.map(r => {
    const ageSec = Math.max(0, Math.round((Date.now() - r.capturedAtMs) / 1000));
    const age = ageSec < 60 ? ageSec + 's' : ageSec < 3600 ? Math.round(ageSec / 60) + 'm' : Math.round(ageSec / 3600) + 'h';
    const settle = r.canComplete
      ? `<input type="number" step="0.01" class="settle" value="${escapeHtml(settleEdits[r.rrn] != null ? settleEdits[r.rrn] : r.amount)}">`
      : '<span class="muted small">—</span>';
    return `<tr data-rrn="${escapeHtml(r.rrn)}">
      <td><span class="pill neutral">${escapeHtml(typeById(r.txnLabel).name)}</span>${r.targetName ? `<div class="sub">${escapeHtml(r.targetName)}</div>` : ''}</td>
      <td>${escapeHtml(r.rrn)}</td>
      <td>${escapeHtml(r.account)}</td>
      <td>${escapeHtml(r.toAccount || '')}</td>
      <td class="num">${escapeHtml(Number(r.amount).toFixed(2))}</td>
      <td class="ccy">${escapeHtml(CCY_ALPHA[r.currencyCode] || r.currencyCode)}</td>
      <td>${r.authCode ? escapeHtml(r.authCode) : '<span class="muted">—</span>'}</td>
      <td class="muted">${age}</td>
      <td>${settle}</td>
      <td><div class="actions">
        ${r.canComplete ? '<button class="btn sm ok settle-btn">Settle</button>' : ''}
        <button class="btn sm bad reverse-btn">Reverse</button>
        <span class="result-msg"></span>
      </div></td>
    </tr>`;
  }).join('');
}

function setConn(online) {
  $('conn').className = 'conn ' + (online ? 'online' : 'offline');
  $('connText').textContent = online ? (AGENT.hosted ? 'Agent connected' : 'Console online') : (AGENT.hosted ? 'Agent offline' : 'Console offline');
  if (online && !targetsState.targets.length) loadTargets();
}

async function followOn(btn, url, extra, label) {
  const tr = btn.closest('tr');
  const rrn = tr.dataset.rrn;
  const msg = tr.querySelector('.result-msg');
  const buttons = tr.querySelectorAll('button');
  tr.dataset.busy = '1';
  buttons.forEach(b => b.disabled = true);
  msg.className = 'result-msg'; msg.textContent = 'sending…';
  try {
    const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rrn, ...extra }) });
    const d = await res.json();
    if (d.ok) {
      msg.className = 'result-msg ok'; msg.textContent = `${d.responseCode} · ${d.latencyMs}ms`;
      toast(`${label} approved for RRN ${rrn}`, 'ok');
      setTimeout(() => { delete tr.dataset.busy; loadAuthorizations(); }, 1500);
      return;
    }
    const why = d.error || `${d.responseCode} ${CODE_DESC[d.responseCode] || 'declined'}`;
    msg.className = 'result-msg bad'; msg.textContent = why;
    toast(`${label} failed for RRN ${rrn}: ${why}`, 'bad');
  } catch (e) {
    msg.className = 'result-msg bad'; msg.textContent = String(e);
  }
  buttons.forEach(b => b.disabled = false);
  delete tr.dataset.busy;
}

document.addEventListener('click', (e) => {
  if (e.target.classList.contains('settle-btn')) {
    const amount = e.target.closest('tr').querySelector('.settle').value;
    followOn(e.target, '/api/complete', { amount }, 'Settlement');
  } else if (e.target.classList.contains('reverse-btn')) {
    followOn(e.target, '/api/reverse', {}, 'Reversal');
  }
});
$('refreshAuthBtn').addEventListener('click', loadAuthorizations);

// ---------- Views ----------
function showView(v) {
  document.querySelectorAll('.view-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.view === v)));
  $('viewLoad').hidden = v !== 'load';
  $('viewUat').hidden = v !== 'uat';
  store.set('view', v);
  if (v === 'uat') { loadCases(); loadRunHistory(); } else drawChart();
}
document.querySelector('.views').addEventListener('click', (e) => { const b = e.target.closest('.view-tab'); if (b) showView(b.dataset.view); });

// ---------- UAT: case library ----------
const ACTION_NAMES = {
  WITHDRAWAL: 'Withdrawal', PURCHASE: 'POS purchase', TRANSFER: 'Transfer', BALANCE_INQUIRY: 'Balance', SIGNON: 'Sign on',
  REFUND: 'Refund', CASH_DEPOSIT: 'Cash deposit', COMPLETION: 'Settle', REVERSAL: 'Reverse',
};
const FOLLOW_ONS = ['COMPLETION', 'REVERSAL'];
let uatCases = [];
const uatSelected = new Set(store.get('uatSelected', []));
$('uatTester').value = store.get('tester', '');
$('uatTester').addEventListener('input', () => store.set('tester', $('uatTester').value));

async function uatApi(path, body) {
  const res = await apiFetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadCases() {
  try { uatCases = (await uatApi('/api/uat/cases')).cases; renderCases(); } catch (e) { toast(e.message, 'bad'); }
}

const expectLabel = (e) => (e && e.startsWith('!') ? 'not ' + e.slice(1) : e);
function stepChip(s) {
  const cls = s.action === 'COMPLETION' ? 'ok' : s.action === 'REVERSAL' ? 'bad' : 'neutral';
  const amt = s.settleAmount || s.amount;
  const role = [s.from, s.to].filter(a => a && a.startsWith('@')).join('→');
  return `<span class="chain-step"><span class="pill ${cls}">${escapeHtml(ACTION_NAMES[s.action] || s.action)}</span>${s.remote === 'Y' ? '<span class="pill warn">remote</span>' : ''}${role ? `<span class="mono role">${escapeHtml(role)}</span>` : ''}${amt ? `<span class="mono muted">${escapeHtml(amt)}</span>` : ''}<span class="expect mono" title="Expected response code">→ ${escapeHtml(expectLabel(s.expect))}</span></span>`;
}

function renderCases() {
  const q = $('caseSearch').value.trim().toLowerCase();
  for (const id of [...uatSelected]) if (!uatCases.some(c => c.id === id)) uatSelected.delete(id);
  const shown = uatCases.filter(c => !q || [c.id, c.name, c.description, c.category, ...c.steps.map(s => s.action + ' ' + (ACTION_NAMES[s.action] || ''))].join(' ').toLowerCase().includes(q));
  $('caseCount').textContent = uatCases.length;
  $('caseList').innerHTML = shown.length ? shown.map(c => `
    <li class="case-item ${uatSelected.has(c.id) ? 'sel' : ''}" data-id="${escapeHtml(c.id)}">
      <input type="checkbox" class="case-chk" ${uatSelected.has(c.id) ? 'checked' : ''} aria-label="Select ${escapeHtml(c.id)}">
      <div class="case-main">
        <div class="case-title"><span class="mono case-id">${escapeHtml(c.id)}</span> ${escapeHtml(c.name)}</div>
        ${c.description ? `<div class="case-desc">${escapeHtml(c.description)}</div>` : ''}
        <div class="chain">${c.steps.map(stepChip).join('<span class="chain-arrow">›</span>')}</div>
      </div>
      <span class="t-actions">
        <button type="button" class="t-btn" data-act="run" title="Run just this case"><svg viewBox="0 0 24 24"><path d="M7 4l12 8-12 8z"/></svg></button>
        <button type="button" class="t-btn" data-act="copy" title="Duplicate"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg></button>
        <button type="button" class="t-btn" data-act="edit" title="Edit"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg></button>
      </span>
    </li>`).join('') : `<li class="muted small">${uatCases.length ? 'No case matches the filter.' : 'No cases yet — add one or import a spreadsheet.'}</li>`;
  const allShownSel = shown.length && shown.every(c => uatSelected.has(c.id));
  $('caseAll').checked = !!allShownSel;
  $('caseAll').indeterminate = !allShownSel && shown.some(c => uatSelected.has(c.id));
  $('caseDeleteBtn').disabled = !uatSelected.size;
  store.set('uatSelected', [...uatSelected]);
  renderUatTarget();
}
$('caseSearch').addEventListener('input', renderCases);
$('caseAll').addEventListener('change', () => {
  document.querySelectorAll('.case-item').forEach(li => { $('caseAll').checked ? uatSelected.add(li.dataset.id) : uatSelected.delete(li.dataset.id); });
  renderCases();
});
$('caseList').addEventListener('click', (e) => {
  const li = e.target.closest('.case-item');
  if (!li) return;
  const id = li.dataset.id;
  const btn = e.target.closest('.t-btn');
  if (btn) {
    const c = uatCases.find(x => x.id === id);
    if (btn.dataset.act === 'edit') openCaseEditor(c, false);
    else if (btn.dataset.act === 'copy') openCaseEditor(c, true);
    else if (btn.dataset.act === 'run') startUatRun([id]);
    return;
  }
  uatSelected.has(id) ? uatSelected.delete(id) : uatSelected.add(id);
  renderCases();
});
$('caseDeleteBtn').addEventListener('click', async () => {
  const ids = [...uatSelected];
  if (!ids.length || !confirm(`Delete ${ids.length} test case${ids.length > 1 ? 's' : ''} (${ids.join(', ')})? Past run evidence is kept.`)) return;
  try { uatCases = (await uatApi('/api/uat/cases/delete', { ids })).cases; ids.forEach(i => uatSelected.delete(i)); renderCases(); } catch (e) { toast(e.message, 'bad'); }
});

function renderUatTarget() {
  if (!$('uatTargetLine')) return;
  const t = activeTarget();
  $('uatTargetLine').textContent = t ? `→ ${targetLabel(t)}` : '—';
  const d = Object.assign({}, BUILTIN_DEFAULTS, (t && t.defaults) || {});
  const pan = d.pan && d.pan.length > 10 ? d.pan.slice(0, 6) + '…' + d.pan.slice(-4) : d.pan;
  $('uatDefaults').textContent = `TID ${d.terminalId || '—'} · ACQ ${d.acquiringInstitution || '—'} · ${ccyLabel(d.currencyCode)} · ${pan}`;
  const n = uatSelected.size;
  const steps = uatCases.filter(c => uatSelected.has(c.id)).reduce((a, c) => a + c.steps.length, 0);
  $('uatSummary').innerHTML = n ? `<b>${n} case${n > 1 ? 's' : ''}</b> · ${steps} message${steps > 1 ? 's' : ''} → ${escapeHtml(t ? t.name : '—')}<br><span class="muted">Runs one step at a time, in list order.</span>` : 'Select cases on the left.';
  $('uatRunBtn').disabled = !n || uatRunning;
  renderRoles();
}

// ---------- UAT: account roles (per target) ----------
const caseRoles = (cases) => [...new Set(cases.flatMap(c => c.steps.flatMap(s => [s.from, s.to]))
  .filter(a => a && a.startsWith('@')).map(a => a.slice(1)))].sort();
let rolesKey = null;      // target + role list currently rendered; avoids rebuilding under the cursor
let saveRolesTimer = null;
function renderRoles() {
  const t = activeTarget();
  if (!t) return;
  const saved = t.accounts || {};
  const selRoles = caseRoles(uatCases.filter(c => uatSelected.has(c.id)));
  // Roles the selected cases use come first.
  const roles = [...new Set([...caseRoles(uatCases), ...Object.keys(saved)])]
    .sort((x, y) => (selRoles.includes(y) - selRoles.includes(x)) || x.localeCompare(y));
  const missing = selRoles.filter(r => !saved[r]);
  const set = roles.filter(r => saved[r]).length;
  $('rolesHint').innerHTML = `${set}/${roles.length} set on ${escapeHtml(t.name)}` +
    (missing.length ? ` · <span style="color:var(--bad)">${missing.length} needed by selection</span>` : '');
  const key = t.id + '|' + roles.join(',');
  if (key === rolesKey && $('rolesGrid').contains(document.activeElement)) return;
  rolesKey = key;
  $('rolesGrid').innerHTML = roles.length ? roles.map(r => `
    <label class="role-row ${selRoles.includes(r) && !saved[r] ? 'need' : ''}">
      <span class="mono">@${escapeHtml(r)}</span>
      <input type="text" class="mono" data-role="${escapeHtml(r)}" value="${escapeHtml(saved[r] || '')}" placeholder="account number">
    </label>`).join('') : '<div class="muted small">No case uses a role yet.</div>';
}
$('rolesGrid').addEventListener('input', () => {
  const id = (activeTarget() || {}).id;
  clearTimeout(saveRolesTimer);
  $('rolesSaved').className = 'saved-note'; $('rolesSaved').textContent = 'saving…';
  saveRolesTimer = setTimeout(async () => {
    const accounts = Object.fromEntries([...$('rolesGrid').querySelectorAll('input')].map(i => [i.dataset.role, i.value.trim()]));
    try {
      targetsState = await targetsApi('/api/targets/accounts', { id, accounts });
      $('rolesSaved').className = 'saved-note ok';
      $('rolesSaved').textContent = `saved for ${(targetsState.targets.find(x => x.id === id) || {}).name || id}`;
      renderTargets();
    } catch (e) { $('rolesSaved').className = 'saved-note bad'; $('rolesSaved').textContent = e.message; }
  }, 700);
});

// ---------- UAT: case editor ----------
let editingId = null;
function stepRowHtml(s) {
  const opts = Object.keys(ACTION_NAMES).map(a => `<option value="${a}" ${a === s.action ? 'selected' : ''}>${ACTION_NAMES[a]}</option>`).join('');
  const v = (k) => escapeHtml(s[k] || '');
  return `<tr>
    <td class="muted n"></td>
    <td><select class="s-action">${opts}</select></td>
    <td><input class="s-from" value="${v('from')}" placeholder="acct / @ROLE"></td>
    <td><input class="s-to" value="${v('to')}" placeholder="acct / @ROLE"></td>
    <td><input class="s-amount" value="${v('amount')}" placeholder="default" inputmode="decimal"></td>
    <td><input class="s-currency sm" value="${escapeHtml(s.currency ? (CCY_ALPHA[s.currency] || s.currency) : '')}" placeholder="def"></td>
    <td><input class="s-settle" value="${v('settleAmount')}" placeholder="—" inputmode="decimal"></td>
    <td><input class="s-pan" value="${v('pan')}" placeholder="target card"></td>
    <td class="c"><input type="checkbox" class="s-remote" ${s.remote === 'Y' ? 'checked' : ''}></td>
    <td><input class="s-expect sm" value="${escapeHtml(s.expect || '00')}"></td>
    <td><span class="t-actions"><button type="button" class="t-btn" data-mv="-1" title="Move up">↑</button><button type="button" class="t-btn" data-mv="1" title="Move down">↓</button><button type="button" class="t-btn del" data-rm title="Remove step"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></span></td>
  </tr>`;
}
function syncStepRows() {
  [...$('cdSteps').rows].forEach((tr, i) => {
    tr.querySelector('.n').textContent = i + 1;
    const a = tr.querySelector('.s-action').value;
    const fo = FOLLOW_ONS.includes(a);
    tr.querySelector('.s-from').disabled = fo || a === 'SIGNON';
    tr.querySelector('.s-to').disabled = a !== 'TRANSFER';
    tr.querySelector('.s-amount').disabled = fo || a === 'SIGNON' || a === 'BALANCE_INQUIRY';
    tr.querySelector('.s-currency').disabled = fo || a === 'SIGNON' || a === 'BALANCE_INQUIRY';
    tr.querySelector('.s-pan').disabled = fo || a === 'SIGNON';
    tr.querySelector('.s-settle').disabled = a !== 'COMPLETION';
    tr.querySelector('.s-remote').disabled = fo || a === 'SIGNON';
  });
}
function addStep(s) {
  const rows = [...$('cdSteps').rows];
  // A new follow-on defaults to the previous financial step's amount.
  if (s.action === 'COMPLETION' && !s.settleAmount) {
    const prev = rows.reverse().map(tr => tr.querySelector('.s-amount').value).find(Boolean);
    if (prev) s.settleAmount = prev;
  }
  if (!FOLLOW_ONS.includes(s.action) && !s.from) {
    const prevFrom = [...$('cdSteps').rows].map(tr => tr.querySelector('.s-from').value).filter(Boolean).pop();
    if (prevFrom) s.from = prevFrom;
  }
  $('cdSteps').insertAdjacentHTML('beforeend', stepRowHtml(s));
  syncStepRows();
}
function openCaseEditor(c, copy) {
  editingId = c && !copy ? c.id : null;
  $('cdTitle').textContent = c ? (copy ? `Copy of ${c.id}` : `Edit ${c.id}`) : 'New test case';
  $('cdId').value = c && !copy ? c.id : '';
  $('cdId').readOnly = !!editingId;
  $('cdName').value = c ? (copy ? c.name + ' (copy)' : c.name) : '';
  $('cdDesc').value = c ? c.description || '' : '';
  $('cdPre').value = c ? c.precondition || '' : '';
  $('cdExp').value = c ? c.expectedResult || '' : '';
  $('cdSteps').innerHTML = '';
  (c ? c.steps : [{ action: 'PURCHASE', expect: '00' }]).forEach(s => $('cdSteps').insertAdjacentHTML('beforeend', stepRowHtml(s)));
  syncStepRows();
  $('cdMsg').textContent = '';
  $('caseDlg').showModal();
  $('cdName').focus();
}
$('caseNewBtn').addEventListener('click', () => openCaseEditor(null));
$('cdClose').addEventListener('click', () => $('caseDlg').close());
$('cdCancel').addEventListener('click', () => $('caseDlg').close());
document.querySelector('.cd-add').addEventListener('click', (e) => { const b = e.target.closest('[data-add]'); if (b) addStep({ action: b.dataset.add, expect: '00' }); });
$('cdSteps').addEventListener('change', (e) => { if (e.target.classList.contains('s-action')) syncStepRows(); });
$('cdSteps').addEventListener('click', (e) => {
  const b = e.target.closest('.t-btn');
  if (!b) return;
  const tr = b.closest('tr');
  if (b.hasAttribute('data-rm')) tr.remove();
  else if (b.dataset.mv === '-1' && tr.previousElementSibling) tr.parentNode.insertBefore(tr, tr.previousElementSibling);
  else if (b.dataset.mv === '1' && tr.nextElementSibling) tr.parentNode.insertBefore(tr.nextElementSibling, tr);
  syncStepRows();
});

function readSteps() {
  return [...$('cdSteps').rows].map((tr, i) => {
    const get = (c) => { const el = tr.querySelector(c); return el.disabled ? '' : el.value.trim(); };
    const s = { action: tr.querySelector('.s-action').value, expect: tr.querySelector('.s-expect').value.trim() || '00' };
    const map = { from: '.s-from', to: '.s-to', amount: '.s-amount', settleAmount: '.s-settle', pan: '.s-pan' };
    for (const [k, sel] of Object.entries(map)) { const v = get(sel); if (v) s[k] = /amount/i.test(k) ? v.replace(/,/g, '') : v; }
    const rm = tr.querySelector('.s-remote');
    if (rm.checked && !rm.disabled) s.remote = 'Y';
    const ccyRaw = get('.s-currency');
    if (ccyRaw) {
      const ccy = resolveCcy(ccyRaw);
      if (!ccy) throw new Error(`Step ${i + 1}: unknown currency ${ccyRaw}`);
      s.currency = ccy;
    }
    return s;
  });
}
$('caseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const c = { id: $('cdId').value.trim() || null, name: $('cdName').value.trim(), description: $('cdDesc').value.trim(), steps: readSteps() };
    if (editingId) { const old = uatCases.find(x => x.id === editingId); if (old && old.category) c.category = old.category; }
    if ($('cdPre').value.trim()) c.precondition = $('cdPre').value.trim();
    if ($('cdExp').value.trim()) c.expectedResult = $('cdExp').value.trim();
    if (!editingId && c.id && uatCases.some(x => x.id === c.id) && !confirm(`${c.id} already exists. Replace it?`)) return;
    const d = await uatApi('/api/uat/cases', { case: c });
    uatCases = d.cases;
    uatSelected.add(d.saved.id);
    renderCases();
    $('caseDlg').close();
    toast(`Saved ${d.saved.id}`, 'ok');
  } catch (err) { $('cdMsg').textContent = err.message; }
});

// ---------- UAT: spreadsheet import / export ----------
const CASE_COLS = ['case_id', 'case_name', 'category', 'description', 'precondition', 'expected_result', 'step', 'action', 'from_account', 'to_account', 'amount', 'currency', 'settle_amount', 'card', 'remote', 'expected_code', 'note'];
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function casesToCsv(cases) {
  const lines = [CASE_COLS.join(',')];
  for (const c of cases) c.steps.forEach((s, i) => lines.push([c.id, c.name, i ? '' : c.category, i ? '' : c.description, i ? '' : c.precondition, i ? '' : c.expectedResult, i + 1, s.action, s.from, s.to, s.amount, s.currency ? (CCY_ALPHA[s.currency] || s.currency) : '', s.settleAmount, s.pan, s.remote, s.expect, s.note].map(csvCell).join(',')));
  return lines.join('\r\n') + '\r\n';
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('caseExportBtn').addEventListener('click', () => download('uat-cases.csv', '﻿' + casesToCsv(uatCases), 'text/csv'));
$('caseTemplateBtn').addEventListener('click', () => download('uat-cases-template.csv', casesToCsv([
  { id: 'TC-101', name: 'POS purchase then settle', description: 'Hold placed, then posted on settlement', steps: [{ action: 'PURCHASE', from: '000100000001', amount: '25.00', currency: '951', expect: '00' }, { action: 'COMPLETION', settleAmount: '25.00', expect: '00' }] },
  { id: 'TC-102', name: 'Transfer then reverse', description: '', steps: [{ action: 'TRANSFER', from: '000100000001', to: '000100000002', amount: '9.00', expect: '00' }, { action: 'REVERSAL', expect: '00' }] },
  { id: 'TC-103', name: 'Withdrawal over balance', description: 'Negative test', steps: [{ action: 'WITHDRAWAL', from: '000100000001', amount: '9999999.00', expect: '51' }] },
]), 'text/csv'));

// RFC 4180-ish: quoted cells may contain the delimiter, quotes ("") and newlines.
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const delim = ['\t', ';', ','].find(d => first.includes(d)) || ',';
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
function csvToCases(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file has no data rows');
  const head = rows[0].map(h => norm(h.trim()));
  const col = (name, ...alts) => [name, ...alts].map(n => head.indexOf(n)).find(i => i >= 0);
  const ix = {
    cat: col('category'), pre: col('precondition', 'pre_condition'), expRes: col('expected_result'),
    id: col('case_id', 'id', 'test_id', 'test_case_#', 'test_case'), name: col('case_name', 'name', 'title'), desc: col('description', 'desc', 'acceptance_criteria'),
    action: col('action', 'type', 'transaction'), from: col('from_account', 'from', 'account'), to: col('to_account', 'to'),
    amount: col('amount'), ccy: col('currency', 'ccy'), settle: col('settle_amount', 'settlement_amount', 'settle'),
    pan: col('card', 'pan', 'card_number'), remote: col('remote', 'remote_on_us'), expect: col('expected_code', 'expected', 'expect', 'expected_response'), note: col('note', 'notes', 'remarks'),
  };
  if (ix.action == null) throw new Error('Missing an "action" column — download the Template to see the layout');
  if (ix.name == null && ix.id == null) throw new Error('Needs a case_id or case_name column');
  const aliases = { POS: 'PURCHASE', POS_PURCHASE: 'PURCHASE', ATM: 'WITHDRAWAL', ATM_WITHDRAWAL: 'WITHDRAWAL', BALANCE: 'BALANCE_INQUIRY', SETTLE: 'COMPLETION', SETTLEMENT: 'COMPLETION', REVERSE: 'REVERSAL', FUND_TRANSFER: 'TRANSFER', DEPOSIT: 'CASH_DEPOSIT' };
  const byKey = new Map();
  rows.slice(1).forEach((r, n) => {
    const g = (k) => (ix[k] != null ? (r[ix[k]] || '').trim() : '');
    const key = g('id') || g('name');
    if (!key) throw new Error(`Row ${n + 2}: no case_id / case_name`);
    let c = byKey.get(key);
    if (!c) {
      c = { id: g('id') || null, name: g('name') || g('id'), description: g('desc'), steps: [] };
      if (g('cat')) c.category = g('cat');
      if (g('pre')) c.precondition = g('pre');
      if (g('expRes')) c.expectedResult = g('expRes');
      byKey.set(key, c);
    }
    else if (!c.description && g('desc')) c.description = g('desc');
    let action = norm(g('action')).toUpperCase();
    action = aliases[action] || action;
    if (!ACTION_NAMES[action]) throw new Error(`Row ${n + 2}: unknown action "${g('action')}"`);
    const s = { action, expect: g('expect').replace(/^'/, '') || '00' };
    if (g('from')) s.from = g('from').replace(/^'/, '');
    if (g('to')) s.to = g('to').replace(/^'/, '');
    if (g('amount')) s.amount = g('amount').replace(/,/g, '');
    if (g('settle')) s.settleAmount = g('settle').replace(/,/g, '');
    if (g('pan')) s.pan = g('pan').replace(/[\s']/g, '');
    if (g('note')) s.note = g('note');
    if (/^(y|yes|true|1)$/i.test(g('remote'))) s.remote = 'Y';
    if (g('ccy')) { const ccy = resolveCcy(g('ccy')); if (!ccy) throw new Error(`Row ${n + 2}: unknown currency ${g('ccy')}`); s.currency = ccy; }
    if (/^\d$/.test(s.expect)) s.expect = '0' + s.expect; // Excel strips the leading zero of "05"
    c.steps.push(s);
  });
  return [...byKey.values()];
}
$('caseImport').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const cases = csvToCases(reader.result);
      const clashes = cases.filter(c => c.id && uatCases.some(x => x.id === c.id)).map(c => c.id);
      if (clashes.length && !confirm(`${clashes.length} case${clashes.length > 1 ? 's' : ''} already exist (${clashes.slice(0, 6).join(', ')}${clashes.length > 6 ? '…' : ''}) and will be replaced. Continue?`)) return;
      const d = await uatApi('/api/uat/cases/import', { cases, replace: false });
      uatCases = d.cases;
      renderCases();
      toast(`Imported ${d.imported} case${d.imported > 1 ? 's' : ''} from ${file.name}`, 'ok');
    } catch (err) { toast('Import failed: ' + err.message, 'bad'); }
  };
  reader.readAsText(file);
});

// ---------- UAT: execution ----------
let uatRunning = false;
let uatRunId = store.get('uatRunId', null);
let uatPollTimer = null;
const openCases = new Set();

async function startUatRun(ids) {
  $('uatError').hidden = true;
  const t = activeTarget();
  if (!ids.length) return;
  if (!$('uatTester').value.trim()) {
    $('uatError').textContent = 'Enter the tester name — it goes on the evidence report.';
    $('uatError').hidden = false; $('uatTester').focus();
    return;
  }
  const missing = caseRoles(uatCases.filter(c => ids.includes(c.id))).filter(r => !((t && t.accounts) || {})[r]);
  if (missing.length && !confirm(`${missing.length} account role${missing.length > 1 ? 's are' : ' is'} not set for ${t ? t.name : 'this target'}: @${missing.join(', @')}.\n\nSteps using them will be marked SKIPPED (BLOCKED on the bank sheet). Run anyway?`)) {
    $('rolesBox').open = true;
    return;
  }
  const order = uatCases.map(c => c.id).filter(id => ids.includes(id)); // library order
  try {
    const d = await uatApi('/api/uat/run', { caseIds: order, targetId: t && t.id, tester: $('uatTester').value.trim() });
    openRun(d.runId);
    toast(`Started ${d.runId} against ${t ? t.name : 'target'}`, 'ok');
  } catch (e) { $('uatError').textContent = e.message; $('uatError').hidden = false; }
}
$('uatRunBtn').addEventListener('click', () => startUatRun([...uatSelected]));

function openRun(id) {
  uatRunId = id;
  store.set('uatRunId', id);
  openCases.clear();
  clearInterval(uatPollTimer);
  pollRun();
  uatPollTimer = setInterval(pollRun, 700);
}

async function pollRun() {
  if (!uatRunId) return;
  let run;
  try { run = await uatApi('/api/uat/run?id=' + encodeURIComponent(uatRunId)); }
  catch (e) { clearInterval(uatPollTimer); uatRunId = null; store.set('uatRunId', null); return; }
  uatRunning = run.status === 'RUNNING';
  renderRun(run);
  renderUatTarget();
  if (!uatRunning) {
    clearInterval(uatPollTimer);
    loadRunHistory();
  }
}

const statusCls = (s) => (s === 'PASS' ? 'ok' : s === 'FAIL' || s === 'ERROR' ? 'bad' : s === 'SKIPPED' ? 'warn' : 'neutral');
function renderRun(run) {
  const sm = run.summary || {};
  const done = (sm.pass || 0) + (sm.fail || 0);
  $('uatRunTitle').textContent = `${run.id} · ${run.target}`;
  $('uatRunSub').textContent = `${run.tester || '—'} · started ${run.startedAt}${run.finishedAt ? ' · finished ' + run.finishedAt.slice(11) : ''} · ${sm.pass || 0} passed · ${sm.fail || 0} failed · ${sm.total || 0} cases`;
  $('uatProgress').style.width = (sm.total ? Math.round(done / sm.total * 100) : 0) + '%';
  $('uatProgress').classList.toggle('bad', !!sm.fail);
  const st = $('uatRunStatus');
  st.className = 'status ' + (run.status === 'RUNNING' ? 'running' : sm.fail || run.status !== 'DONE' ? 'cancelled' : 'done');
  st.textContent = run.status === 'RUNNING' ? 'Running' : run.status === 'DONE' ? (sm.fail ? `${sm.fail} failed` : 'All passed') : run.status;
  $('uatRunActions').hidden = false;
  $('uatReportBtn').href = AGENT.link('/api/uat/report?id=' + encodeURIComponent(run.id));
  $('uatCsvBtn').href = AGENT.link('/api/uat/export?id=' + encodeURIComponent(run.id));
  $('uatBankBtn').href = AGENT.link('/api/uat/export?format=bank&id=' + encodeURIComponent(run.id));

  $('uatResults').innerHTML = run.cases.map(c => {
    const open = openCases.has(c.caseId) || (c.status === 'FAIL' && !openCases.has('!' + c.caseId));
    const steps = c.steps.map(s => `
      <tr class="${s.status === 'PASS' ? '' : 'row-' + statusCls(s.status)}">
        <td class="muted">${s.no}</td>
        <td>${escapeHtml(ACTION_NAMES[s.action] || s.action)}<div class="sub mono">${escapeHtml([s.mti, s.procCode].filter(Boolean).join(' · '))}</div></td>
        <td>${escapeHtml(s.rrn || '')}${s.parentRrn ? `<div class="sub">parent ${escapeHtml(s.parentRrn)}</div>` : ''}</td>
        <td>${escapeHtml(s.from || '')}${s.fromRole ? `<div class="sub">${escapeHtml(s.fromRole)}</div>` : ''}${s.to ? ' → ' + escapeHtml(s.to) : ''}</td>
        <td class="num">${escapeHtml(s.amount || '')} <span class="muted">${escapeHtml(CCY_ALPHA[s.currency] || s.currency || '')}</span></td>
        <td class="mono">${escapeHtml(expectLabel(s.expect))}</td>
        <td><span class="pill ${statusCls(s.status)} code" title="${escapeHtml(CODE_DESC[s.actual] || '')}">${escapeHtml(s.actual)}</span></td>
        <td class="num">${s.latencyMs != null ? s.latencyMs : ''}</td>
        <td><span class="pill ${statusCls(s.status)}">${escapeHtml(s.status)}</span>${s.error ? `<div class="sub err">${escapeHtml(s.error)}</div>` : ''}</td>
      </tr>`).join('');
    const pending = (c.definition || []).length - c.steps.length;
    return `<div class="res-case ${open ? 'open' : ''}" data-id="${escapeHtml(c.caseId)}">
      <button type="button" class="res-head">
        <svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
        <span class="mono case-id">${escapeHtml(c.caseId)}</span>
        <span class="res-name">${escapeHtml(c.name)}</span>
        <span class="res-steps mono muted">${c.steps.length}/${(c.definition || []).length}</span>
        <span class="pill ${statusCls(c.status)}">${escapeHtml(c.status)}</span>
      </button>
      <div class="res-body">
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>#</th><th>Step</th><th>RRN</th><th>Accounts</th><th class="num">Amount</th><th>Expect</th><th>Actual</th><th class="num">ms</th><th>Result</th></tr></thead>
          <tbody>${steps || ''}${pending > 0 ? `<tr><td colspan="9" class="muted small">${pending} step${pending > 1 ? 's' : ''} pending…</td></tr>` : ''}</tbody>
        </table></div>
      </div>
    </div>`;
  }).join('');
}
$('uatResults').addEventListener('click', (e) => {
  const h = e.target.closest('.res-head');
  if (!h) return;
  const box = h.parentElement;
  const id = box.dataset.id;
  box.classList.toggle('open');
  if (box.classList.contains('open')) { openCases.add(id); openCases.delete('!' + id); } else { openCases.delete(id); openCases.add('!' + id); }
});

async function loadRunHistory() {
  let runs;
  try { runs = (await uatApi('/api/uat/runs')).runs; } catch (e) { return; }
  $('runHistory').innerHTML = runs.length ? runs.map(r => {
    const s = r.summary || {};
    const cls = r.status === 'RUNNING' ? 'neutral' : s.fail ? 'bad' : r.status === 'DONE' ? 'ok' : 'warn';
    return `<tr data-id="${escapeHtml(r.id)}" class="${r.id === uatRunId ? 'current' : ''}">
      <td><button type="button" class="link-plain" data-act="open">${escapeHtml(r.id)}</button><div class="sub">${escapeHtml(r.startedAt || '')}</div></td>
      <td class="muted">${escapeHtml(r.target || '')}</td>
      <td class="muted">${escapeHtml(r.tester || '')}</td>
      <td><span class="pill ${cls}">${r.status === 'RUNNING' ? 'running' : `${s.pass || 0}/${s.total || 0}`}</span></td>
      <td><div class="actions">
        <a class="btn sm ghost-plain" href="${escapeHtml(AGENT.link('/api/uat/report?id=' + encodeURIComponent(r.id)))}" target="_blank" rel="noopener">Report</a>
        <a class="btn sm ghost-plain" href="${escapeHtml(AGENT.link('/api/uat/export?id=' + encodeURIComponent(r.id)))}">CSV</a>
        <a class="btn sm ghost-plain" href="${escapeHtml(AGENT.link('/api/uat/export?format=bank&id=' + encodeURIComponent(r.id)))}" title="Bank test-sheet layout">Bank</a>
        <button type="button" class="t-btn del" data-act="del" title="Delete run and its evidence"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>
      </div></td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="muted small">No runs yet</td></tr>';
}
$('runHistory').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.closest('tr').dataset.id;
  if (b.dataset.act === 'open') { openRun(id); loadRunHistory(); }
  else if (b.dataset.act === 'del') {
    if (!confirm(`Permanently delete ${id} and its evidence file? This cannot be undone.`)) return;
    try {
      await uatApi('/api/uat/runs/delete', { id });
      if (uatRunId === id) { uatRunId = null; store.set('uatRunId', null); $('uatResults').innerHTML = ''; $('uatRunActions').hidden = true; $('uatRunTitle').textContent = 'No run open'; }
      loadRunHistory();
    } catch (err) { toast(err.message, 'bad'); }
  }
});

// ---------- Init ----------
renderTypes();
onTypeChanged();
// Hosted: wait until signed in and connected to the user's agent.
AGENT.ready.then(() => {
  showView(store.get('view', 'load'));
  if (uatRunId) openRun(uatRunId);
  loadTargets();
  loadAuthorizations();
  setInterval(loadAuthorizations, 5000);
});
