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
  list: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l9-9M16 6l3 3"/>',
  bill: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  cash: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  cashback: '<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M8 13l-2 2 2 2M6 15h7"/>',
  offline: '<path d="M4 14a8 8 0 0 1 12-7"/><path d="M20 10a8 8 0 0 1-12 7"/><path d="M3 3l18 18"/>',
  poweroff: '<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/><path d="M4 20l16-16"/>',
};

const COL_LABELS = { from: 'from_account', to: 'to_account', amount: 'amount', currency: 'currency' };

// cls = message class (MTI without the version digit); proc = default processing code; net = network code per version.
// tag: status on the FLEXCUBE switch (UAT, 2026-09-25). Untagged types are confirmed there.
const TYPES = [
  { id: 'WITHDRAWAL', name: 'ATM Withdrawal', cls: '200', proc: '010000', icon: 'atm', cols: ['from', 'amount', 'currency'] },
  { id: 'PURCHASE', name: 'POS Purchase', cls: '100', proc: '000000', icon: 'card', cols: ['from', 'amount', 'currency'] },
  { id: 'TRANSFER', name: 'Account Transfer', cls: '200', proc: '400020', icon: 'transfer', cols: ['from', 'to', 'amount', 'currency'] },
  { id: 'BALANCE_INQUIRY', name: 'Balance Inquiry', cls: '200', proc: '310000', icon: 'eye', cols: ['from'] },
  { id: 'MINI_STATEMENT', name: 'Mini Statement', cls: '200', proc: '380000', icon: 'list', cols: ['from'] },
  { id: 'PIN_CHANGE', name: 'PIN Change', cls: '200', proc: '920000', icon: 'key', cols: ['from'], tag: 'Not on this switch' },
  { id: 'CASH_ADVANCE', name: 'POS Cash Advance', cls: '100', proc: '010000', icon: 'cash', cols: ['from', 'amount', 'currency'] },
  { id: 'PURCHASE_CASHBACK', name: 'Purchase + Cashback', cls: '200', proc: '090000', icon: 'cashback', cols: ['from', 'amount', 'currency'], tag: 'Not on this switch' },
  { id: 'BILL_PAYMENT', name: 'Bill Payment', cls: '200', proc: '500000', icon: 'bill', cols: ['from', 'to', 'amount', 'currency'], tag: 'Needs biller setup' },
  { id: 'OFFLINE_PURCHASE', name: 'Offline Purchase', cls: '220', proc: '000000', icon: 'offline', cols: ['from', 'amount', 'currency'] },
  { id: 'REFUND', name: 'Refund', cls: '200', proc: '200000', icon: 'refund', cols: ['from', 'amount', 'currency'] },
  { id: 'CASH_DEPOSIT', name: 'Cash Deposit', cls: '200', proc: '210000', icon: 'deposit', cols: ['from', 'amount', 'currency'] },
  { id: 'SIGNON', name: 'Sign On', cls: '800', net: { '0': '301', '1': '801', '2': '801' }, icon: 'power', cols: [] },
  { id: 'SIGNOFF', name: 'Sign Off', cls: '800', net: { '0': '002', '1': '802', '2': '802' }, icon: 'poweroff', cols: [], tag: 'Untested' },
];
const typeById = (id) => TYPES.find(t => t.id === id) || TYPES[0];

// ---------- Bundles: several transaction types in one run ----------
const MONEY = (t) => t.cols.includes('amount');   // posts or holds money, so it can be reversed
const SETTLES = (t) => t.cls === '100';           // 0100 authorizations can be settled (0220)
const FOLLOW_LABEL = { NONE: 'No follow-up', REVERSE: 'Reverse after approval', SETTLE: 'Settle after approval' };
const PRESETS = {
  neutral: [
    { type: 'WITHDRAWAL', weight: 40, then: 'REVERSE' }, { type: 'PURCHASE', weight: 25, then: 'REVERSE' },
    { type: 'TRANSFER', weight: 10, then: 'REVERSE' }, { type: 'BALANCE_INQUIRY', weight: 15, then: 'NONE' },
    { type: 'MINI_STATEMENT', weight: 10, then: 'NONE' }],
  atm: [
    { type: 'WITHDRAWAL', weight: 50, then: 'NONE' }, { type: 'BALANCE_INQUIRY', weight: 30, then: 'NONE' },
    { type: 'MINI_STATEMENT', weight: 15, then: 'NONE' }, { type: 'TRANSFER', weight: 5, then: 'NONE' }],
  pos: [
    { type: 'PURCHASE', weight: 60, then: 'SETTLE' }, { type: 'CASH_ADVANCE', weight: 15, then: 'NONE' },
    { type: 'OFFLINE_PURCHASE', weight: 15, then: 'NONE' }, { type: 'REFUND', weight: 10, then: 'NONE' }],
};

// ---------- Message profiles (ISO 8583 version per switch) ----------
let profiles = [];   // from /api/profiles
const profileOf = (t) => profiles.find(p => p.id === ((t && t.profile) || 'flexcube-87')) || { id: 'flexcube-87', name: 'FLEXCUBE switch (ISO 8583:1987)', version: '1987', verified: true, approved: ['00'] };
const versionDigit = (v) => (v === '1993' ? '1' : v === '2003' ? '2' : '0');
function typeCode(t, target) {
  const d = versionDigit(profileOf(target).version);
  if (t.cls === '800') return (d === '0' ? '0800' : d + '804') + ' · ' + t.net[d];
  return d + t.cls + ' · ' + ((profileOf(target).procCodes || {})[t.id] || t.proc);
}

const TEMPLATES = {
  BUNDLE: 'from_account,to_account,amount,currency\n000123456001,000123456002,10.00,USD\n000123456002,000123456001,5.00,USD\n',
  TRANSFER: 'from_account,to_account,amount,currency\n000123456001,000123456002,9.00,USD\n000123456001,000123456002,12.50,840\n',
  WITHDRAWAL: 'from_account,amount,currency\n000123456001,20.00,USD\n000123456002,15.00,USD\n',
  PURCHASE: 'from_account,amount,currency\n000123456001,18.00,USD\n000123456002,25.00,USD\n',
  REFUND: 'from_account,amount,currency\n000123456001,5.00,USD\n',
  CASH_DEPOSIT: 'from_account,amount,currency\n000123456001,50.00,USD\n',
  BALANCE_INQUIRY: 'from_account\n000123456001\n000123456002\n',
  MINI_STATEMENT: 'from_account\n000123456001\n',
  PIN_CHANGE: 'from_account\n000123456001\n',
  CASH_ADVANCE: 'from_account,amount,currency\n000123456001,40.00,USD\n',
  PURCHASE_CASHBACK: 'from_account,amount,currency\n000123456001,30.00,USD\n',
  BILL_PAYMENT: 'from_account,to_account,amount,currency\n000123456001,000123456002,75.00,USD\n',
  OFFLINE_PURCHASE: 'from_account,amount,currency\n000123456001,12.00,USD\n',
};

// ISO 4217 alpha -> numeric, for the currencies this bank sees most.
const CCY = { USD: '840', EUR: '978', GBP: '826', CAD: '124', INR: '356', XCD: '951', TTD: '780', BBD: '052', JMD: '388' };
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
  // ISO 8583:1993 / 2003 action codes
  '000': 'Approved', '001': 'Honour with identification', '002': 'Approved for partial amount', '100': 'Do not honour',
  '101': 'Expired card', '106': 'PIN tries exceeded', '110': 'Invalid amount', '111': 'Invalid card number',
  '116': 'Not sufficient funds', '117': 'Incorrect PIN', '119': 'Not permitted to cardholder', '121': 'Exceeds withdrawal limit',
  '400': 'Reversal accepted', '800': 'Network message accepted', '902': 'Invalid transaction', '904': 'Format error',
  '909': 'System malfunction', '911': 'Issuer timed out', '0000': 'Approved',
  'MTI:1814': 'Network response (1814)', 'MTI:2814': 'Network response (2814)',
};
const OK_CODES = new Set(['00', '000', '001', '002', '400', '800', '0000', 'MTI:0810', 'MTI:1814', 'MTI:2814']);
const codeClass = (c) => OK_CODES.has(c) ? 'ok' : (c === 'NO_RESPONSE' || String(c).startsWith('MTI:')) ? 'warn' : 'bad';

// ---------- State ----------
let currentType = typeById(store.get('type', 'TRANSFER'));
let mode = store.get('mode', 'single') === 'bundle' ? 'bundle' : 'single';
let bundle = (store.get('bundle', null) || PRESETS.neutral)
  .filter(b => TYPES.some(t => t.id === b.type) && b.type !== 'SIGNOFF')
  .map(b => ({ type: b.type, weight: Math.max(1, Number(b.weight) || 1), then: b.then || 'NONE' }));
let runName = '';             // name of the running test, for the finish toast

/** What Run sends: the selected type, or the bundle as a pseudo-type whose data columns are the union of its types'. */
function activeType() {
  if (mode !== 'bundle') return currentType;
  const types = bundle.map(b => typeById(b.type));
  const cols = ['from', 'to', 'amount', 'currency'].filter(c => types.some(t => t.cols.includes(c)));
  return { id: 'BUNDLE', name: `Bundle · ${bundle.length} type${bundle.length === 1 ? '' : 's'}`, cls: types.length && types.every(t => t.cls === '800') ? '800' : 'mix', cols, toOptional: true };
}
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
  if (res.status === 402) showUpgrade(data);
  if (!res.ok || data.error) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadTargets() {
  try {
    const pr = await targetsApi('/api/profiles');
    profiles = pr.profiles || [];
    $('tfProfile').innerHTML = profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.verified ? ' — verified' : ' — not tested on a switch'}</option>`).join('');
  } catch (e) { /* older agent without profiles: FLEXCUBE 1987 assumed */ }
  try { targetsState = await targetsApi('/api/targets'); renderTargets(); } catch (e) { /* shown via conn indicator */ }
}

function renderTargets() {
  const t = activeTarget();
  $('targetName').textContent = t ? t.name : '—';
  $('targetAddr').textContent = t ? `${t.host}:${t.port}` : '';
  const prof = profileOf(t);
  $('targetFmt').textContent = 'ISO ' + prof.version + (prof.verified ? '' : ' · untested');
  $('targetFmt').className = 'target-fmt' + (prof.verified ? '' : ' warn');
  targetTitle();
  $('targetList').innerHTML = targetsState.targets.map(x => {
    const st = targetTests[x.id];
    return `<li class="t-item ${x.id === targetsState.active ? 'active' : ''}" data-id="${escapeHtml(x.id)}" title="Use this target">
      <span class="t-radio"></span>
      <span class="t-main"><div class="t-name">${escapeHtml(x.name)}</div><div class="t-addr">${escapeHtml(x.host)}:${x.port} · ${escapeHtml(profileOf(x).name)}${bankDb[x.id] && bankDb[x.id].configured ? ' · money check' : ''}</div></span>
      ${st ? `<span class="t-status ${st.ok ? 'ok' : 'bad'}">${escapeHtml(st.text)}</span>` : ''}
      <span class="t-actions">
        <button type="button" class="t-btn" data-act="test" title="Test TCP connection"><svg viewBox="0 0 24 24"><path d="M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0"/><circle cx="12" cy="16" r="1.5"/></svg></button>
        <button type="button" class="t-btn" data-act="db" title="Bank database (money checks)"><svg viewBox="0 0 24 24"><ellipse cx="12" cy="6" rx="7" ry="2.6"/><path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6"/></svg></button>
        <button type="button" class="t-btn" data-act="edit" title="Edit"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg></button>
        <button type="button" class="t-btn del" data-act="del" title="Remove"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg></button>
      </span>
    </li>`;
  }).join('');
  fillTargetDefaults(false);
  renderTypes();
  refreshSummaries();
  if (typeof renderUatTarget === 'function') renderUatTarget();
  if (t && !(t.id in bankDb)) loadBankDb(t.id); else renderMoneyButtons();
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
      $('tfProfile').value = t.profile || 'flexcube-87';
      $('tfTitle').textContent = `Edit ${t.name}`; $('tfSave').textContent = 'Save changes'; $('tfCancel').hidden = false;
      $('tfMsg').textContent = ''; $('tfHost').focus();
    } else if (act === 'db') {
      openDbDialog(t);
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
  const body = { id: $('tfId').value || null, name: $('tfName').value.trim() || null, host: $('tfHost').value.trim(), port: $('tfPort').value, profile: $('tfProfile').value || null };
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
  const inBundle = new Set(bundle.map(b => b.type));
  const multi = mode === 'bundle';
  $('typeGrid').setAttribute('role', multi ? 'group' : 'radiogroup');
  $('typeGrid').innerHTML = TYPES.map(t => {
    const on = multi ? inBundle.has(t.id) : t.id === currentType.id;
    const blocked = multi && t.id === 'SIGNOFF';
    return `
    <button type="button" class="type-tile" role="${multi ? 'checkbox' : 'radio'}" data-type="${t.id}" aria-checked="${on}"${blocked ? ' disabled title="Sign off would sign the switch interface off in the middle of the run"' : ''}>
      <span class="type-ico"><svg viewBox="0 0 24 24">${ICONS[t.icon]}</svg></span>
      <span><span class="type-name">${t.name}</span><span class="type-code">${typeCode(t, activeTarget())}</span>${t.tag && profileOf(activeTarget()).verified ? `<span class="type-tag">${t.tag}</span>` : ''}</span>
    </button>`;
  }).join('');
}
$('typeGrid').addEventListener('click', (e) => {
  const tile = e.target.closest('.type-tile');
  if (!tile || tile.disabled) return;
  if (mode === 'bundle') {
    const i = bundle.findIndex(b => b.type === tile.dataset.type);
    if (i >= 0) bundle.splice(i, 1);
    else bundle.push({ type: tile.dataset.type, weight: 10, then: 'NONE' });
    bundleChanged();
    return;
  }
  dataText[currentType.id] = $('rowsText').value;
  currentType = typeById(tile.dataset.type);
  store.set('type', currentType.id);
  renderTypes();
  onTypeChanged();
});

function onTypeChanged() {
  const t = activeType();
  const hasData = t.cols.length > 0;
  $('dataArea').hidden = !hasData;
  $('noDataNote').hidden = hasData;
  $('templateBtn').hidden = !hasData;
  $('formatCols').innerHTML = t.cols.map((c, i) =>
    (i ? '<span class="col-sep">,</span>' : '') +
    `<span class="col-chip ${c === 'from' || (c === 'to' && !t.toOptional) ? 'req' : ''}">${COL_LABELS[c]}</span>`).join('');
  $('rowsText').placeholder = (TEMPLATES[t.id] || '').trim();
  $('rowsText').value = dataText[t.id] || '';
  $('drop').classList.toggle('loaded', !!$('rowsText').value.trim());
  reparse();
}

function setMode(m) {
  const prev = $('rowsText').value;
  dataText[activeType().id] = prev;
  mode = m;
  store.set('mode', m);
  // Rows with a header row mean the same thing for any type, so they carry over into an empty bundle.
  if (m === 'bundle' && !dataText.BUNDLE && hasHeader(prev)) dataText.BUNDLE = prev;
  document.querySelectorAll('.mode-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
  document.querySelectorAll('.bundle-only').forEach(el => { el.hidden = m !== 'bundle'; });
  $('bundleBox').hidden = m !== 'bundle';
  renderPlan();
  renderTypes();
  renderBundle();
  onTypeChanged();
}
document.querySelector('.mode-seg').addEventListener('click', (e) => {
  const b = e.target.closest('.mode-tab');
  if (b && b.dataset.mode !== mode) setMode(b.dataset.mode);
});

function bundleChanged() {
  store.set('bundle', bundle);
  renderTypes();
  renderBundle();
  onTypeChanged();
}
const bundleTotal = () => bundle.reduce((n, b) => n + (Number(b.weight) || 0), 0) || 1;
const bundleShare = (b) => Math.round((Number(b.weight) || 0) / bundleTotal() * 100) + '%';

function renderBundle() {
  if (mode !== 'bundle') return;
  renderBundleBar();
  $('bundleList').innerHTML = bundle.length ? bundle.map((b, i) => {
    const t = typeById(b.type);
    const opts = ['NONE'].concat(MONEY(t) ? ['REVERSE'] : [], SETTLES(t) ? ['SETTLE'] : []);
    return `<li class="bundle-item" data-i="${i}">
      <span class="bi-swatch bb-${i % 6}"></span>
      <span class="bi-name">${escapeHtml(t.name)}${t.tag && profileOf(activeTarget()).verified ? ` <span class="type-tag">${t.tag}</span>` : ''}<span class="type-code">${typeCode(t, activeTarget())}</span></span>
      <label class="bi-weight"><input type="number" min="1" max="1000" step="1" value="${b.weight}" data-bi-weight aria-label="Weight of ${escapeHtml(t.name)}"><span class="bi-share">${bundleShare(b)}</span></label>
      <button type="button" class="bi-remove" data-bi-remove aria-label="Remove ${escapeHtml(t.name)}">×</button>
      ${opts.length > 1 ? `<select data-bi-then aria-label="Follow-up for ${escapeHtml(t.name)}">${opts.map(o => `<option value="${o}"${o === b.then ? ' selected' : ''}>${FOLLOW_LABEL[o]}</option>`).join('')}</select>` : ''}
    </li>`;
  }).join('') : '<li class="bundle-empty">Empty bundle: click transaction types above, or pick a preset.</li>';
  $('bundleEffect').innerHTML = bundleEffect();
}
function renderBundleBar() {
  $('bundleBar').innerHTML = bundle.map((b, i) => `<span class="bb-${i % 6}" style="flex:${Number(b.weight) || 0}" title="${escapeHtml(typeById(b.type).name)} ${bundleShare(b)}"></span>`).join('');
}

/** What the bundle does to account balances, in one sentence. */
function bundleEffect() {
  if (!bundle.length) return '';
  const money = bundle.filter(b => MONEY(typeById(b.type)));
  if (!money.length) return 'No money moves: inquiries and network messages only.';
  const stays = money.filter(b => b.then !== 'REVERSE');
  if (!stays.length) return '<b>Balance-neutral.</b> Every money-moving message is reversed straight after approval, so balances end where they started. A reversal that is declined leaves its transaction in Open transactions.';
  return '<b>Moves money:</b> ' + stays.map(b => `${escapeHtml(typeById(b.type).name)}${b.then === 'SETTLE' ? ' (settled)' : ''} ${bundleShare(b)}`).join(', ')
    + '. Approved ones stay in Open transactions, where you can reverse them in bulk.';
}

$('bundleList').addEventListener('input', (e) => {
  const li = e.target.closest('.bundle-item');
  if (!li || !e.target.matches('[data-bi-weight]')) return;
  bundle[+li.dataset.i].weight = Math.min(1000, Math.max(1, Math.round(Number(e.target.value) || 1)));
  store.set('bundle', bundle);
  renderBundleBar();   // not the list: keep focus in the field being typed in
  document.querySelectorAll('#bundleList .bundle-item').forEach(el => { el.querySelector('.bi-share').textContent = bundleShare(bundle[+el.dataset.i]); });
  $('bundleEffect').innerHTML = bundleEffect();
  refreshSummaries();
});
$('bundleList').addEventListener('change', (e) => {
  const li = e.target.closest('.bundle-item');
  if (!li) return;
  if (e.target.matches('[data-bi-then]')) { bundle[+li.dataset.i].then = e.target.value; bundleChanged(); }
  if (e.target.matches('[data-bi-weight]')) renderBundle();   // normalise what was typed
});
$('bundleList').addEventListener('click', (e) => {
  const li = e.target.closest('.bundle-item');
  if (li && e.target.closest('[data-bi-remove]')) { bundle.splice(+li.dataset.i, 1); bundleChanged(); }
});
$('bundleBox').querySelector('.bundle-presets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-preset]');
  if (!b) return;
  bundle = PRESETS[b.dataset.preset].map(x => Object.assign({}, x));
  bundleChanged();
});

// ---------- CSV parsing ----------
const ALIASES = {
  from: ['from', 'from_account', 'fromaccount', 'from_acc', 'account', 'account_no', 'debit_account', 'source'],
  to: ['to', 'to_account', 'toaccount', 'to_acc', 'credit_account', 'destination', 'beneficiary'],
  amount: ['amount', 'amt', 'txn_amount', 'value'],
  currency: ['currency', 'ccy', 'currency_code', 'cur'],
};
const norm = (s) => s.toLowerCase().replace(/[\s-]+/g, '_');

/** True when the first non-comment line names its columns (from_account, amount, ...). */
function hasHeader(text) {
  const line = (text || '').split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
  if (!line) return false;
  const delim = ['\t', ';', '|', ','].find(d => line.includes(d)) || ',';
  return splitLine(line, delim).map(norm).some(h => Object.values(ALIASES).some(a => a.includes(h)));
}

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
      if (!r.to) { if (!type.toOptional) r.errors.push('missing to_account'); }
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
  dataText[activeType().id] = $('rowsText').value;
  parsed = parseRows($('rowsText').value, activeType());
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
  const at = activeType();
  if (at.id !== 'BUNDLE' && at.cols.includes('amount')) {   // a bundle's rows aren't all money-moving
    const defAmt = Number($('amount').value) || 0;
    const defCcy = resolveCcy($('currencyCode').value) || $('currencyCode').value;
    for (const r of valid) {
      const c = r.currency || defCcy;
      totals[c] = (totals[c] || 0) + (r.amount ? Number(r.amount) : defAmt);
    }
  }
  $('totalsLine').textContent = Object.entries(totals).map(([c, v]) => `${v.toFixed(2)} ${CCY_ALPHA[c] || c}`).join(' · ');

  const cols = at.cols;
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
  const csv = TEMPLATES[activeType().id];
  if (!csv) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = activeType().id.toLowerCase() + '_template.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- Load profile & summaries ----------
// Browser-local: amount and rotating PANs. Per target (targets.json): terminal, institutions, currency, card.
const LOCAL_FIELDS = ['amount', 'pansText'];
const TARGET_FIELDS = ['terminalId', 'acquiringInstitution', 'forwardingInstitution', 'currencyCode', 'pan', 'remoteAcquirer'];
const BUILTIN_DEFAULTS = { terminalId: 'ATM1', acquiringInstitution: '100001', forwardingInstitution: '', currencyCode: '840', pan: '4000000000000002', remoteAcquirer: '' };
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

// ---------- Placeholder card / acquirer ----------
// The downloadable app ships placeholder values instead of any bank's real test card and acquirer.
// A switch can't recognise them as its own, so it declines (usually 05, off-us).
const SAMPLE_PANS = new Set(['4000000000000002']);
const SAMPLE_ACQUIRERS = new Set(['100001', '100002', '100003']);
const spacedPan = (p) => String(p).replace(/(\d{4})(?=\d)/g, '$1 ');

/** Problems with the card / acquirer that will actually be sent. */
function sampleIssues(pan, acquirer, rotation) {
  const issues = [];
  const cards = rotation && rotation.length ? rotation : [pan];
  const sampleCards = cards.filter(c => SAMPLE_PANS.has(String(c).trim()));
  if (sampleCards.length) issues.push({ what: 'card', text: `the placeholder card number ${spacedPan(sampleCards[0])}` });
  if (SAMPLE_ACQUIRERS.has(String(acquirer).trim())) issues.push({ what: 'acquirer', text: `the placeholder acquirer ${String(acquirer).trim()}` });
  return issues;
}
function loadViewIssues() {
  return sampleIssues($('pan').value, $('acquiringInstitution').value, $('pansText').value.split(/[\r\n,]+/).map(x => x.trim()).filter(Boolean));
}
function uatViewIssues() {
  const t = activeTarget();
  const d = Object.assign({}, BUILTIN_DEFAULTS, (t && t.defaults) || {});
  return sampleIssues(d.pan, d.acquiringInstitution, null);
}
function sampleMessage(issues, target) {
  const what = issues.map(i => i.text).join(' and ');
  return `<div><b>${escapeHtml(target ? target.name : 'This switch')} is set to ${escapeHtml(what)}.</b> `
    + `These are samples that ship with SwitchProof, so your switch will decline the transactions (usually 05, off-us). `
    + `Enter your own test card and acquiring institution under Message defaults — they're saved for this switch.</div>`
    + `<button type="button" class="btn sm primary-sm" data-set-card>Set card</button>`;
}
function renderSampleWarnings() {
  const t = activeTarget();
  const li = loadViewIssues(), ui = uatViewIssues();
  $('sampleBanner').hidden = !li.length;
  $('sampleBanner').innerHTML = li.length ? sampleMessage(li, t) : '';
  $('sampleWarn').hidden = !li.length;
  $('sampleWarn').textContent = li.length ? `Sample value — replace ${li.map(i => i.what === 'card' ? 'the card number' : 'the acquiring institution').join(' and ')} with your own.` : '';
  ['pan', 'acquiringInstitution'].forEach(id => $(id).classList.toggle('is-sample', li.some(i => (i.what === 'card') === (id === 'pan'))));
  $('uatSampleWarn').hidden = !ui.length;
  $('uatSampleWarn').innerHTML = ui.length ? sampleMessage(ui, t) : '';
}
/** Asks before sending with placeholder values; true = go ahead. */
function confirmSample(issues) {
  if (!issues.length) return true;
  return confirm(`This switch is set to ${issues.map(i => i.text).join(' and ')}.\n\nThat's a sample value, so the switch will decline (usually 05). Set your own under Message defaults.\n\nSend anyway?`);
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-set-card]')) return;
  showView('load');
  $('defaultsCard').open = true;
  $('defaultsCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => { const el = SAMPLE_ACQUIRERS.has($('acquiringInstitution').value.trim()) && !SAMPLE_PANS.has($('pan').value.trim()) ? $('acquiringInstitution') : $('pan'); el.focus(); el.select(); }, 350);
});

function refreshSummaries() {
  renderSampleWarnings();
  const n = validRows().length;
  const at = activeType();
  const usesData = at.cols.length > 0;
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
  // Follow-ups are extra messages on the same connections: up to one per approved money-moving execution.
  const followShare = mode === 'bundle' ? bundle.filter(b => b.then !== 'NONE').reduce((x, b) => x + b.weight, 0) / bundleTotal() : 0;
  const followPart = followShare ? ` · up to ${Math.round(count * followShare)} follow-ups` : '';
  $('fireSummary').innerHTML = `<b>${escapeHtml(at.name)}</b> → ${escapeHtml(t ? t.name : '—')}<br>${count} tx over ${dur || 0}s · ${$('concurrency').value || 1} parallel${followPart}${rowsPart}`;
}

// ---------- Run ----------
$('startBtn').addEventListener('click', async () => {
  clearError();
  const at = activeType();
  if (mode === 'bundle' && !bundle.length) { showError('The bundle is empty: click transaction types to add them, or pick a preset.'); return; }
  if (at.cls !== '800' && !confirmSample(loadViewIssues())) return;
  const usesData = at.cols.length > 0;
  const rows = validRows();
  if (usesData && !rows.length) {
    showError(`Add at least one valid row (${at.cols.map(c => COL_LABELS[c]).join(', ')}).`);
    return;
  }
  const defCcy = resolveCcy($('currencyCode').value);
  if (!defCcy) { showError('Default currency is not recognised. Use a 3-digit code (840) or USD / EUR.'); return; }
  const skipped = parsed.length - rows.length;

  const payload = {
    type: mode === 'bundle' ? bundle[0].type : currentType.id,
    mix: mode === 'bundle' ? bundle.map(b => ({ type: b.type, weight: Number(b.weight) || 1, then: b.then })) : undefined,
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
    if (res.status === 402) showUpgrade(data);
    if (!res.ok) { showError(data.error || 'Failed to start test'); return; }
    currentJobId = data.jobId;
    $('startBtn').disabled = true;
    $('cancelBtn').disabled = false;
    runName = at.name;
    $('runTitle').textContent = `${at.name} · ${payload.count} tx → ${data.target || ''}`;
    renderMoneyButtons();
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
  $('resultsTableBody').innerHTML = '<tr><td colspan="10" class="muted small">Waiting for responses…</td></tr>';
  moneyByKey = {};
  $('moneySum').hidden = true;
  $('resultsTable').classList.remove('with-money');
  $('kindCard').hidden = true;
  $('kindBody').innerHTML = '';
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

  renderErrors(d);
  renderKinds(d.byKind);

  if (d.status === 'DONE' || d.status === 'CANCELLED') {
    clearInterval(pollTimer);
    pollTimer = null;
    $('startBtn').disabled = false;
    $('cancelBtn').disabled = true;
    setStatus(d.status === 'DONE' ? 'done' : 'cancelled', d.status === 'DONE' ? 'Done' : 'Cancelled');
    renderMoneyButtons();
    toast(`${runName}: ${d.approved} approved, ${d.declined} declined, ${d.errors} errors`, d.declined || d.errors ? 'bad' : 'ok');
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

// Identical errors are grouped with a count; dropped connections under concurrency get an explanation.
function renderErrors(d) {
  const counts = d.errorCounts || {};
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    const recent = d.recentErrors || [];
    $('errorList').innerHTML = recent.length
      ? recent.slice().reverse().map(e => `<li>${escapeHtml(e)}</li>`).join('')
      : '<li class="muted small">None</li>';
    return;
  }
  const dropped = entries.filter(([m]) => /^Switch .* (closed|reset|dropped|cut) the connection/.test(m)).reduce((n, e) => n + e[1], 0);
  const hint = dropped && d.concurrency > 1
    ? `<li class="err-hint">The switch accepted ${dropped === 1 ? 'a connection' : dropped + ' connections'} and dropped ${dropped === 1 ? 'it' : 'them'} without a reply.
       This usually means it takes fewer simultaneous connections than your concurrency of ${d.concurrency}: try a lower concurrency.
       Dropped messages are listed in Recent transactions with their RRN, so you can check on the switch whether any were processed.</li>`
    : '';
  $('errorList').innerHTML = hint + entries.map(([m, n]) => `<li><b class="err-n">${n}×</b> ${escapeHtml(m)}</li>`).join('');
}

/** Bundle breakdown: one row per type, each followed by its reversals / settlements. */
function renderKinds(kinds) {
  $('kindCard').hidden = !kinds;
  if (!kinds) return;
  const total = kinds.filter(k => !k.followUp).reduce((n, k) => n + k.weight, 0) || 1;
  $('kindBody').innerHTML = kinds.map(k => `<tr class="${k.followUp ? 'kind-follow' : ''}">
    <td>${k.followUp ? '↳ ' + (k.followUp === 'SETTLE' ? 'Settlement' : 'Reversal') : escapeHtml(typeById(k.type).name)}</td>
    <td class="num">${k.followUp ? '' : Math.round(k.weight / total * 100) + '%'}</td>
    <td class="num">${k.sent}</td>
    <td class="num">${k.approved}</td>
    <td class="num${k.declined ? ' t-bad' : ''}">${k.declined}</td>
    <td class="num${k.errors ? ' t-warn' : ''}">${k.errors}</td>
    <td class="num">${k.avgLatencyMs}</td>
  </tr>`).join('');
}

// F54 balances from a reply: "ledger 9,899,514.85 · available 6,818,704.22"
const fmtAmt = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function balanceLine(bal) {
  if (!bal || !bal.length) return '';
  return `<div class="sub bal-line" title="F54 additional amounts">${bal.map(a => `${escapeHtml(a.label.replace(/ balance$/, ''))} <b>${escapeHtml(fmtAmt(a.amount))}</b>`).join(' · ')} <span class="muted">${escapeHtml(CCY_ALPHA[bal[0].currency] || bal[0].currency)}</span></div>`;
}

function renderResults(rows) {
  lastResults = rows;
  if (!rows.length) return;
  const withMoney = Object.keys(moneyByKey).length > 0;
  $('resultsTable').classList.toggle('with-money', withMoney);
  $('resultsTableBody').innerHTML = rows.slice(-200).reverse().map(r => {
    const code = r.responseCode || (r.mti ? 'MTI:' + r.mti : 'NO_RESPONSE');
    const cls = r.ok ? 'ok' : r.error ? 'warn' : codeClass(code);
    const label = r.responseCode || r.mti || '—';
    const result = r.error
      ? `<span class="pill warn code" title="No reply: see Errors">— ${escapeHtml(r.error.toLowerCase())}</span>`
      : `<span class="pill ${cls} code" title="${escapeHtml(CODE_DESC[code] || '')}">${escapeHtml(label)} ${escapeHtml(r.ok ? 'approved' : (CODE_DESC[code] || 'declined').toLowerCase())}</span>`;
    const typeCell = r.followUp
      ? `<span class="muted">↳ ${r.followUp === 'SETTLE' ? 'settlement' : 'reversal'}</span>`
      : escapeHtml(r.type ? typeById(r.type).name : '');
    return `<tr>
      <td class="muted">${r.index + 1}</td>
      <td class="type-cell">${typeCell}</td>
      <td>${escapeHtml(r.rrn || '')}</td>
      <td>${escapeHtml(r.fromAccount || '')}</td>
      <td>${escapeHtml(r.toAccount || '')}</td>
      <td class="num">${r.amount ? escapeHtml(Number(r.amount).toFixed(2)) : ''}</td>
      <td class="ccy">${escapeHtml(CCY_ALPHA[r.currencyCode] || r.currencyCode || '')}</td>
      <td>${result}</td>
      <td class="num">${r.latencyMs}</td>
      <td class="money-col">${withMoney ? moneyPill(moneyByKey[r.index + '|' + (r.followUp || '')], r.rrn) : ''}</td>
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
const settleEdits = {};        // rrn -> amount typed by the user; survives the periodic refresh
const otSelected = new Set();  // selected RRNs
const otStatus = {};           // rrn -> {cls, text}: last result shown on a row (kept across refreshes)
let authRows = [];             // last list from the agent
let otRun = null;              // bulk run in progress: {stop}

document.addEventListener('input', (e) => {
  if (e.target.classList.contains('settle')) settleEdits[e.target.closest('tr').dataset.rrn] = e.target.value;
});

const otAge = (r) => Math.max(0, Math.round((Date.now() - r.capturedAtMs) / 1000));
const otAgeLabel = (s) => (s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h');
const otSettleAmount = (r) => (settleEdits[r.rrn] != null && settleEdits[r.rrn] !== '' ? settleEdits[r.rrn] : r.amount);

function otFiltered() {
  const type = $('otType').value, q = $('otSearch').value.trim().toLowerCase();
  return authRows.filter(r => (!type || r.txnLabel === type)
    && (!q || [r.rrn, r.account, r.toAccount, r.authCode].some(v => v && String(v).toLowerCase().includes(q))));
}

function otTotals(rows) {
  const t = {};
  for (const r of rows) { const c = CCY_ALPHA[r.currencyCode] || r.currencyCode; t[c] = (t[c] || 0) + Number(r.amount || 0); }
  return Object.entries(t).map(([c, v]) => `${v.toFixed(2)} ${c}`).join(' · ');
}

async function loadAuthorizations() {
  let data;
  try {
    const res = await apiFetch('/api/authorizations');
    data = await res.json();
    setConn(true);
  } catch (e) { setConn(false); return; }
  if (otRun) return;   // a bulk run updates its rows itself
  authRows = data.authorizations || [];
  for (const rrn of [...otSelected]) if (!authRows.some(r => r.rrn === rrn)) otSelected.delete(rrn);
  $('authCount').textContent = authRows.length + ' open';
  // type filter options follow what is in the list
  const types = [...new Set(authRows.map(r => r.txnLabel))];
  const cur = $('otType').value;
  $('otType').innerHTML = '<option value="">All types</option>' + types.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(typeById(t).name)}</option>`).join('');
  $('otType').value = types.includes(cur) ? cur : '';
  // Don't rebuild the table under the user's cursor while they're typing a settle amount.
  if (document.activeElement && document.activeElement.classList.contains('settle')) { otBulkBar(); return; }
  renderAuthTable();
}

function renderAuthTable() {
  const rows = otFiltered();
  if (!authRows.length) {
    $('authTableBody').innerHTML = '<tr><td colspan="11" class="muted small">No open transactions — approved purchases, withdrawals, transfers and other financial transactions appear here.</td></tr>';
  } else if (!rows.length) {
    $('authTableBody').innerHTML = '<tr><td colspan="11" class="muted small">No transaction matches the filter.</td></tr>';
  } else {
    $('authTableBody').innerHTML = rows.map(r => {
      const st = otStatus[r.rrn];
      const settle = r.canComplete
        ? `<input type="number" step="0.01" class="settle" value="${escapeHtml(otSettleAmount(r))}" aria-label="Settle amount">`
        : '<span class="muted small">—</span>';
      return `<tr data-rrn="${escapeHtml(r.rrn)}" class="${otSelected.has(r.rrn) ? 'selected' : ''}">
        <td class="c"><input type="checkbox" class="ot-chk" ${otSelected.has(r.rrn) ? 'checked' : ''} aria-label="Select ${escapeHtml(r.rrn)}"></td>
        <td><span class="pill neutral">${escapeHtml(typeById(r.txnLabel).name)}</span>${r.targetName ? `<div class="sub">${escapeHtml(r.targetName)}</div>` : ''}</td>
        <td>${escapeHtml(r.rrn)}</td>
        <td>${escapeHtml(r.account)}</td>
        <td>${escapeHtml(r.toAccount || '')}</td>
        <td class="num">${escapeHtml(Number(r.amount).toFixed(2))}</td>
        <td class="ccy">${escapeHtml(CCY_ALPHA[r.currencyCode] || r.currencyCode)}</td>
        <td>${r.authCode ? escapeHtml(r.authCode) : '<span class="muted">—</span>'}</td>
        <td class="muted">${otAgeLabel(otAge(r))}</td>
        <td>${settle}</td>
        <td><div class="actions">
          ${r.canComplete ? '<button class="btn sm ok settle-btn">Settle</button>' : ''}
          <button class="btn sm bad reverse-btn">Reverse</button>
          <span class="result-msg ${st ? st.cls : ''}">${st ? escapeHtml(st.text) : ''}</span>
        </div></td>
      </tr>`;
    }).join('');
  }
  otBulkBar();
}

function otBulkBar() {
  const shown = otFiltered();
  const sel = authRows.filter(r => otSelected.has(r.rrn));
  $('otBulk').hidden = !sel.length || !!otRun;
  $('otBulkCount').textContent = `${sel.length} selected`;
  $('otBulkTotal').textContent = otTotals(sel);
  const settleable = sel.filter(r => r.canComplete).length;
  $('otSettle').textContent = settleable === sel.length ? 'Settle selected' : `Settle ${settleable} authorization${settleable === 1 ? '' : 's'}`;
  $('otSettle').disabled = !settleable;
  const allShown = shown.length && shown.every(r => otSelected.has(r.rrn));
  $('otAll').checked = !!allShown;
  $('otAll').indeterminate = !allShown && shown.some(r => otSelected.has(r.rrn));
}

function otSetRow(rrn, cls, text) {
  otStatus[rrn] = { cls, text };
  const tr = document.querySelector(`#authTableBody tr[data-rrn="${CSS.escape(rrn)}"]`);
  if (tr) { const m = tr.querySelector('.result-msg'); m.className = 'result-msg ' + cls; m.textContent = text; }
}

// ---- one row: Settle / Reverse buttons ----
async function followOn(btn, url, extra, label) {
  const tr = btn.closest('tr');
  const rrn = tr.dataset.rrn;
  const buttons = tr.querySelectorAll('button');
  buttons.forEach(b => b.disabled = true);
  otSetRow(rrn, '', 'sending…');
  const r = await otSend(url, rrn, extra);
  if (r.ok) {
    otSetRow(rrn, 'ok', `${r.code} · ${r.ms}ms`);
    toast(`${label} approved for RRN ${rrn}`, 'ok');
    setTimeout(() => { delete otStatus[rrn]; loadAuthorizations(); }, 1500);
    return;
  }
  otSetRow(rrn, 'bad', r.why);
  toast(`${label} failed for RRN ${rrn}: ${r.why}`, 'bad');
  buttons.forEach(b => b.disabled = false);
}

async function otSend(url, rrn, extra) {
  try {
    const res = await apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rrn, ...extra }) });
    const d = await res.json();
    if (d.ok) return { ok: true, code: d.responseCode, ms: d.latencyMs };
    return { ok: false, why: d.error || `${d.responseCode} ${CODE_DESC[d.responseCode] || 'declined'}` };
  } catch (e) {
    return { ok: false, why: String(e.message || e) };
  }
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

// ---- selection ----
$('authTableBody').addEventListener('change', (e) => {
  if (!e.target.classList.contains('ot-chk')) return;
  const tr = e.target.closest('tr');
  e.target.checked ? otSelected.add(tr.dataset.rrn) : otSelected.delete(tr.dataset.rrn);
  tr.classList.toggle('selected', e.target.checked);
  otBulkBar();
});
$('otAll').addEventListener('change', () => {
  for (const r of otFiltered()) $('otAll').checked ? otSelected.add(r.rrn) : otSelected.delete(r.rrn);
  renderAuthTable();
});
$('otSelect').addEventListener('change', () => {
  const v = $('otSelect').value;
  $('otSelect').value = '';
  const shown = otFiltered();
  if (v === 'none') otSelected.clear();
  else if (v === 'all') shown.forEach(r => otSelected.add(r.rrn));
  else if (v === 'auth') { otSelected.clear(); shown.filter(r => r.canComplete).forEach(r => otSelected.add(r.rrn)); }
  else if (v === 'old') { otSelected.clear(); shown.filter(r => otAge(r) > 15 * 60).forEach(r => otSelected.add(r.rrn)); }
  renderAuthTable();
});
$('otClear').addEventListener('click', () => { otSelected.clear(); renderAuthTable(); });
$('otType').addEventListener('change', renderAuthTable);
$('otSearch').addEventListener('input', renderAuthTable);

// ---- bulk settle / reverse ----
async function otBulk(kind) {
  const sel = authRows.filter(r => otSelected.has(r.rrn));
  const items = kind === 'settle' ? sel.filter(r => r.canComplete) : sel;
  if (!items.length) return;
  const skipped = sel.length - items.length;
  const targets = [...new Set(items.map(r => r.targetName || 'the active switch'))];
  const verb = kind === 'settle' ? 'Settle' : 'Reverse';
  const lines = [
    `${verb} ${items.length} transaction${items.length === 1 ? '' : 's'} (${otTotals(items)})`,
    `on ${targets.join(', ')}?`,
    kind === 'settle' ? 'Each is settled at the amount in its Settle amount box.' : 'Each is fully reversed with its original RRN.',
    skipped ? `${skipped} selected row${skipped === 1 ? ' is not an authorization and is' : 's are not authorizations and are'} skipped.` : '',
    targets.some(t => /prod/i.test(t)) ? '\nThis includes a PRODUCTION switch — real accounts will be affected.' : '',
  ].filter(Boolean);
  if (!confirm(lines.join('\n'))) return;

  otRun = { stop: false };
  $('otBulk').hidden = true;
  $('otSummary').hidden = true;
  $('otProgress').hidden = false;
  $('otStop').disabled = false;
  document.querySelectorAll('#authTableBody button, #authTableBody input').forEach(el => { el.disabled = true; });
  const url = kind === 'settle' ? '/api/complete' : '/api/reverse';
  const ok = [], failed = [];
  for (let i = 0; i < items.length; i++) {
    if (otRun.stop) break;
    const r = items[i];
    $('otProgressText').textContent = `${kind === 'settle' ? 'Settling' : 'Reversing'} ${i + 1} of ${items.length} · RRN ${r.rrn}`;
    $('otProgressFill').style.width = Math.round(i / items.length * 100) + '%';
    otSetRow(r.rrn, '', 'sending…');
    const res = await otSend(url, r.rrn, kind === 'settle' ? { amount: otSettleAmount(r) } : {});
    if (res.ok) { ok.push(r); otSetRow(r.rrn, 'ok', `${res.code} · ${res.ms}ms`); otSelected.delete(r.rrn); }
    else { failed.push({ r, why: res.why }); otSetRow(r.rrn, 'bad', res.why); }
  }
  const stopped = otRun.stop;
  const notSent = items.length - ok.length - failed.length;
  $('otProgressFill').style.width = '100%';
  otRun = null;
  $('otProgress').hidden = true;
  const noun = kind === 'settle' ? 'settled' : 'reversed';
  $('otSummary').innerHTML = `<b>${ok.length} ${noun}</b>` + (failed.length ? ` · <span class="bad">${failed.length} failed</span>` : '')
    + (notSent ? ` · ${notSent} not sent (stopped)` : '') + (ok.length ? ` · ${escapeHtml(otTotals(ok))}` : '')
    + (failed.length ? '<ul>' + failed.slice(0, 10).map(f => `<li class="mono">${escapeHtml(f.r.rrn)} — ${escapeHtml(f.why)}</li>`).join('') + (failed.length > 10 ? `<li>… and ${failed.length - 10} more (still selected)</li>` : '') + '</ul>' : '')
    + '<button type="button" class="link-btn" id="otSummaryClose">Dismiss</button>';
  $('otSummary').className = 'ot-summary ' + (failed.length ? 'bad' : 'ok');
  $('otSummary').hidden = false;
  toast(`${ok.length} ${noun}${failed.length ? `, ${failed.length} failed` : ''}${stopped ? ' (stopped)' : ''}`, failed.length ? 'bad' : 'ok');
  for (const r of ok) delete otStatus[r.rrn];   // gone from the list after refresh
  loadAuthorizations();
}
$('otSettle').addEventListener('click', () => otBulk('settle'));
$('otReverse').addEventListener('click', () => otBulk('reverse'));
$('otStop').addEventListener('click', () => { if (otRun) { otRun.stop = true; $('otStop').disabled = true; $('otProgressText').textContent += ' — stopping after this one'; } });
document.addEventListener('click', (e) => { if (e.target.id === 'otSummaryClose') $('otSummary').hidden = true; });

// ---- remove from list (nothing is sent to the switch) ----
$('otForget').addEventListener('click', async () => {
  const rrns = [...otSelected];
  if (!rrns.length) return;
  if (!confirm(`Remove ${rrns.length} transaction${rrns.length === 1 ? '' : 's'} from this list?\n\nNothing is sent to the switch: they stay as they are there (still held or posted). Use this for entries you've already settled or reversed some other way.`)) return;
  try {
    const res = await apiFetch('/api/authorizations/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rrns }) });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || 'Request failed');
    rrns.forEach(r => { otSelected.delete(r); delete otStatus[r]; });
    toast(`Removed ${d.removed} from the list`, 'ok');
    loadAuthorizations();
  } catch (e) { toast(e.message, 'bad'); }
});

// ---- export ----
$('otExport').addEventListener('click', () => {
  const rows = otSelected.size ? authRows.filter(r => otSelected.has(r.rrn)) : otFiltered();
  if (!rows.length) { toast('Nothing to export', 'bad'); return; }
  const cols = ['type', 'switch', 'rrn', 'from_account', 'to_account', 'amount', 'currency', 'auth_code', 'captured_at', 'can_settle'];
  const lines = [cols.join(',')].concat(rows.map(r => [typeById(r.txnLabel).name, r.targetName, r.rrn, r.account, r.toAccount, Number(r.amount).toFixed(2),
    CCY_ALPHA[r.currencyCode] || r.currencyCode, r.authCode, new Date(r.capturedAtMs).toISOString(), r.canComplete ? 'yes' : 'no'].map(csvCell).join(',')));
  download(`open-transactions-${new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')}.csv`, '﻿' + lines.join('\r\n') + '\r\n', 'text/csv');
});

function setConn(online) {
  $('conn').className = 'conn ' + (online ? 'online' : 'offline');
  $('connText').textContent = online ? (AGENT.hosted ? 'Agent connected' : 'Console online') : (AGENT.hosted ? 'Agent offline' : 'Console offline');
  targetTitle();
  if (online && !targetsState.targets.length) loadTargets();
}

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
  SIGNOFF: 'Sign off', MINI_STATEMENT: 'Mini statement', PIN_CHANGE: 'PIN change', CASH_ADVANCE: 'Cash advance',
  PURCHASE_CASHBACK: 'Purchase + cashback', BILL_PAYMENT: 'Bill payment', OFFLINE_PURCHASE: 'Offline purchase',
  REFUND: 'Refund', CASH_DEPOSIT: 'Cash deposit', COMPLETION: 'Settle', REVERSAL: 'Reverse',
};
const NETWORK_ACTIONS = ['SIGNON', 'SIGNOFF'];
const INQUIRY_ACTIONS = ['BALANCE_INQUIRY', 'MINI_STATEMENT', 'PIN_CHANGE'];
const TWO_ACCOUNT_ACTIONS = ['TRANSFER', 'BILL_PAYMENT'];
const FOLLOW_ONS = ['COMPLETION', 'REVERSAL'];
let uatCases = [];
const uatSelected = new Set(store.get('uatSelected', []));
$('uatTester').value = store.get('tester', '');
$('uatTester').addEventListener('input', () => store.set('tester', $('uatTester').value));

async function uatApi(path, body) {
  const res = await apiFetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (res.status === 402) showUpgrade(data);
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
  renderSampleWarnings();
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
    <td><input class="s-proc sm" value="${v('proc')}" placeholder="def" inputmode="numeric" maxlength="6" title="Processing code override (6 digits)"></td>
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
    const net = NETWORK_ACTIONS.includes(a), inq = INQUIRY_ACTIONS.includes(a);
    tr.querySelector('.s-from').disabled = fo || net;
    tr.querySelector('.s-to').disabled = !TWO_ACCOUNT_ACTIONS.includes(a);
    tr.querySelector('.s-amount').disabled = fo || net || inq;
    tr.querySelector('.s-currency').disabled = fo || net || inq;
    tr.querySelector('.s-pan').disabled = fo || net;
    tr.querySelector('.s-settle').disabled = a !== 'COMPLETION';
    tr.querySelector('.s-remote').disabled = fo || net;
    tr.querySelector('.s-proc').disabled = fo || net;
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
    const proc = get('.s-proc');
    if (proc) {
      if (!/^\d{6}$/.test(proc)) throw new Error(`Step ${i + 1}: processing code must be 6 digits`);
      s.proc = proc;
    }
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
const CASE_COLS = ['case_id', 'case_name', 'category', 'description', 'precondition', 'expected_result', 'step', 'action', 'from_account', 'to_account', 'amount', 'currency', 'settle_amount', 'card', 'remote', 'processing_code', 'expected_code', 'note'];
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function casesToCsv(cases) {
  const lines = [CASE_COLS.join(',')];
  for (const c of cases) c.steps.forEach((s, i) => lines.push([c.id, c.name, i ? '' : c.category, i ? '' : c.description, i ? '' : c.precondition, i ? '' : c.expectedResult, i + 1, s.action, s.from, s.to, s.amount, s.currency ? (CCY_ALPHA[s.currency] || s.currency) : '', s.settleAmount, s.pan, s.remote, s.proc, s.expect, s.note].map(csvCell).join(',')));
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
  { id: 'TC-101', name: 'POS purchase then settle', description: 'Hold placed, then posted on settlement', steps: [{ action: 'PURCHASE', from: '000123456001', amount: '25.00', currency: '840', expect: '00' }, { action: 'COMPLETION', settleAmount: '25.00', expect: '00' }] },
  { id: 'TC-102', name: 'Transfer then reverse', description: '', steps: [{ action: 'TRANSFER', from: '000123456001', to: '000123456002', amount: '9.00', expect: '00' }, { action: 'REVERSAL', expect: '00' }] },
  { id: 'TC-103', name: 'Withdrawal over balance', description: 'Negative test', steps: [{ action: 'WITHDRAWAL', from: '000123456001', amount: '9999999.00', expect: '51' }] },
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
    pan: col('card', 'pan', 'card_number'), remote: col('remote', 'remote_on_us'), proc: col('processing_code', 'proc', 'proc_code'), expect: col('expected_code', 'expected', 'expect', 'expected_response'), note: col('note', 'notes', 'remarks'),
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
    if (g('proc')) s.proc = g('proc').replace(/^'/, '').padStart(6, '0');
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
  if (!confirmSample(uatViewIssues())) return;
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
  $('uatMoneyRecheck').hidden = run.status === 'RUNNING' || !moneyOn(run.targetId);

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
        <td><span class="pill ${statusCls(s.status)}">${escapeHtml(s.status)}</span>${s.error ? `<div class="sub err">${escapeHtml(s.error)}</div>` : ''}${uatMoney(s, run.targetId)}</td>
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

// ---------- Feedback: feature requests, changes, problems (hosted site, stored in Supabase) ----------
// Tables and access rules: tools/supabase-feedback.sql. The board is read through the feedback_board view,
// which never carries who asked (no email, no user id) -- only whether a row is yours; admins also get the email.
const FB_KIND = { feature: 'Feature request', change: 'Change', problem: 'Problem' };
const FB_IMPACT = { nice: 'Nice to have', important: 'Important', blocking: 'Blocking testing' };
const FB_STATUS = { new: 'New', planned: 'Planned', in_progress: 'In progress', done: 'Done', declined: 'Declined' };
const FB_OPEN = ['new', 'planned', 'in_progress'];
const FB_COLS = 'id,created_at,updated_at,kind,area,impact,title,details,status,reply,mine,votes,voted,requester';
const fb = { rows: [], votes: new Map(), myVotes: new Set(), admin: false, tab: 'board', loaded: false, open: new Set() };

function fbClient() {
  const sb = AGENT.supabase && AGENT.supabase();
  if (!sb) { toast('Feedback is available when you are signed in on the SwitchProof website.', 'bad'); return null; }
  return sb;
}
function fbSeen() { return store.get('fbSeen', 0); }
function fbUpdatesForMe() {
  const seen = fbSeen();
  return fb.rows.filter(r => r.mine && (r.reply || r.status !== 'new') && Date.parse(r.updated_at) > seen).length;
}
function fbBadge() {
  const n = fbUpdatesForMe();
  $('fbBadge').hidden = !n;
  $('fbBadge').textContent = n;
  $('fbOpen').title = n ? `${n} of your requests ${n === 1 ? 'has' : 'have'} an update` : 'Request a feature or report a problem';
  acctDot();
}

// ---------- Account menu (website): email, Feedback, Access, Disconnect, Sign out ----------
function acctOpen(open) {
  $('acctMenu').hidden = !open;
  $('acctBtn').setAttribute('aria-expanded', String(open));
}
/** A dot on the account button when Feedback or Access has something new. */
function acctDot() {
  const count = (b) => (b.hidden ? 0 : Number(b.textContent) || 0);
  const n = count($('fbBadge')) + ($('accessOpen').hidden ? 0 : count($('accBadge')));
  $('acctDot').hidden = !n;
  $('acctBtn').title = n ? `Account · ${n} new` : 'Account';
}
$('acctBtn').addEventListener('click', (e) => { e.stopPropagation(); acctOpen($('acctMenu').hidden); });
$('acctMenu').addEventListener('click', (e) => { if (e.target.closest('.acct-item')) acctOpen(false); });
document.addEventListener('click', (e) => { if (!$('acctMenu').hidden && !e.target.closest('.acct')) acctOpen(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('acctMenu').hidden) { acctOpen(false); $('acctBtn').focus(); } });
// The button shows the first letter of the signed-in email (agent.js fills it in after sign-in).
new MutationObserver(() => {
  const email = $('userEmail').textContent.trim();
  $('acctAvatar').textContent = email ? email[0].toUpperCase() : '';
}).observe($('userEmail'), { childList: true, characterData: true, subtree: true });

/** The target button's tooltip carries what no longer fits in the bar: format and connection. */
function targetTitle() {
  const parts = [$('targetName').textContent, $('targetAddr').textContent, $('targetFmt').textContent, $('connText').textContent]
    .map(s => s.trim()).filter(s => s && s !== '—');
  $('targetBtn').title = parts.join(' · ') + '. Click to change the target.';
}
function fbTableMissing(err) {
  return err && (/does not exist|schema cache|relation/i.test(err.message || '') || ['42P01', 'PGRST205', 'PGRST202'].includes(err.code));
}

async function fbLoad() {
  const sb = AGENT.supabase && AGENT.supabase();
  if (!sb) return false;
  $('fbListMsg').textContent = 'Loading…';
  $('fbListMsg').className = 'fb-msg';
  const [rows, admin] = await Promise.all([
    sb.from('feedback_board').select(FB_COLS).order('created_at', { ascending: false }).limit(1000),
    sb.rpc('is_admin'),
  ]);
  if (rows.error) {
    const err = rows.error;
    $('fbListMsg').className = 'fb-msg bad';
    $('fbListMsg').textContent = fbTableMissing(err)
      ? 'Feedback is not set up on this site yet. The site owner needs to run tools/supabase-feedback.sql in Supabase.'
      : 'Could not load requests: ' + err.message;
    return false;
  }
  fb.rows = rows.data || [];
  fb.admin = !admin.error && admin.data === true;
  $('accessOpen').hidden = !fb.admin;
  if (fb.admin && !$('accessDlg').open) accLoad(true).catch(() => {});   // new sales requests, renewals due
  fb.votes = new Map(fb.rows.map(r => [r.id, r.votes || 0]));
  fb.myVotes = new Set(fb.rows.filter(r => r.voted).map(r => r.id));
  fb.loaded = true;
  $('fbListMsg').textContent = '';
  fbBadge();
  return true;
}

function fbTabs(tab) {
  fb.tab = tab;
  document.querySelectorAll('.fb-tab').forEach(b => b.setAttribute('aria-selected', String(b.dataset.fbTab === tab)));
  document.querySelector('[data-fb-pane="list"]').hidden = tab === 'new';
  document.querySelector('[data-fb-pane="new"]').hidden = tab !== 'new';
  if (tab === 'new') setTimeout(() => $('fbTitleInput').focus(), 50);
  else fbRender();
}

function fbRender() {
  const kind = $('fbFilterKind').value, status = $('fbFilterStatus').value, q = $('fbSearch').value.trim().toLowerCase();
  let rows = fb.rows.filter(r => (fb.tab !== 'mine' || r.mine)
    && (!kind || r.kind === kind)
    && (!status || (status === 'open' ? FB_OPEN.includes(r.status) : r.status === status))
    && (!q || (r.title + ' ' + r.details + ' ' + r.area).toLowerCase().includes(q)));
  rows = rows.sort($('fbSort').value === 'new'
    ? (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
    : (a, b) => (fb.votes.get(b.id) || 0) - (fb.votes.get(a.id) || 0) || Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!rows.length) {
    $('fbList').innerHTML = `<li class="fb-empty">${fb.tab === 'mine' ? "You haven't sent any requests yet." : 'No requests match.'} <button type="button" class="link-plain" data-fb-go="new">Send one</button></li>`;
    return;
  }
  const seen = fbSeen();
  $('fbList').innerHTML = rows.map(r => {
    const votes = fb.votes.get(r.id) || 0, mine = r.mine, voted = fb.myVotes.has(r.id), open = fb.open.has(r.id);
    const fresh = mine && (r.reply || r.status !== 'new') && Date.parse(r.updated_at) > seen;
    return `<li class="fb-item ${open ? 'open' : ''}" data-id="${r.id}">
      <button type="button" class="fb-vote ${voted ? 'on' : ''}" data-fb-vote aria-pressed="${voted}" title="${voted ? 'Remove your vote' : 'Vote for this'}">
        <svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg><span>${votes}</span></button>
      <div class="fb-body">
        <button type="button" class="fb-head" data-fb-toggle>
          <span class="fb-title">${escapeHtml(r.title)}</span>
          <span class="fb-meta">${escapeHtml(FB_KIND[r.kind] || r.kind)} · ${escapeHtml(r.area)} · ${escapeHtml(FB_IMPACT[r.impact] || r.impact)} · ${new Date(r.created_at).toLocaleDateString()}${mine ? ' · <b>yours</b>' : ''}${fresh ? ' · <b class="fb-new">updated</b>' : ''}</span>
        </button>
        <div class="fb-detail">
          <p class="fb-text">${escapeHtml(r.details)}</p>
          ${r.reply ? `<div class="fb-reply"><span>Reply from SwitchProof</span><p>${escapeHtml(r.reply)}</p></div>` : ''}
          ${fb.admin ? `<div class="fb-admin">
            <span class="fb-requester" data-requester>Requested by ${escapeHtml(r.requester || 'unknown')}</span>
            <select data-fb-status>${Object.entries(FB_STATUS).map(([k, v]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${v}</option>`).join('')}</select>
            <textarea data-fb-reply rows="3" maxlength="4000" placeholder="Reply to the requester (visible to everyone)">${escapeHtml(r.reply || '')}</textarea>
            <button type="button" class="btn sm primary-sm" data-fb-save>Save</button><span class="fb-msg" data-fb-savemsg></span>
          </div>` : ''}
        </div>
      </div>
      <span class="fb-status s-${r.status}">${escapeHtml(FB_STATUS[r.status] || r.status)}</span>
    </li>`;
  }).join('');
}

async function fbOpenDialog() {
  if (!fbClient()) return;
  $('fbDlg').showModal();
  fbTabs(fb.tab === 'new' ? 'new' : fb.tab);
  if (await fbLoad()) fbRender();
}

// Card numbers (Luhn-valid 13-19 digits), long account-like numbers and private IP addresses.
function fbSensitive(text) {
  const hits = [];
  for (const m of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    const d = m[0].replace(/\D/g, '');
    let sum = 0;
    for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; }
    if (sum % 10 === 0) { hits.push('a card number'); break; }
  }
  if (/\b\d{10,}\b/.test(text) && !hits.length) hits.push('a long number (account or card?)');
  if (/\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/.test(text)) hits.push('an internal IP address');
  return hits;
}

$('fbOpen').addEventListener('click', fbOpenDialog);
$('fbClose').addEventListener('click', () => $('fbDlg').close());
$('fbDlg').addEventListener('close', () => { if (fb.loaded) { store.set('fbSeen', Date.now()); fbBadge(); } });
document.querySelector('.fb-tabs').addEventListener('click', (e) => { const b = e.target.closest('.fb-tab'); if (b) fbTabs(b.dataset.fbTab); });
['fbFilterKind', 'fbFilterStatus', 'fbSort'].forEach(id => $(id).addEventListener('change', fbRender));
$('fbSearch').addEventListener('input', fbRender);

$('fbList').addEventListener('click', async (e) => {
  if (e.target.closest('[data-fb-go]')) { fbTabs('new'); return; }
  const li = e.target.closest('.fb-item');
  if (!li) return;
  const id = Number(li.dataset.id);
  const sb = fbClient();
  if (!sb) return;

  if (e.target.closest('[data-fb-toggle]')) {
    li.classList.toggle('open');
    li.classList.contains('open') ? fb.open.add(id) : fb.open.delete(id);
    return;
  }

  if (e.target.closest('[data-fb-vote]')) {
    const had = fb.myVotes.has(id);
    const res = had
      ? await sb.from('feedback_votes').delete().eq('feedback_id', id)   // row security limits this to your own vote
      : await sb.from('feedback_votes').insert({ feedback_id: id });
    if (res.error) { toast('Vote not saved: ' + res.error.message, 'bad'); return; }
    had ? fb.myVotes.delete(id) : fb.myVotes.add(id);
    fb.votes.set(id, Math.max(0, (fb.votes.get(id) || 0) + (had ? -1 : 1)));
    fbRender();
    return;
  }

  if (e.target.closest('[data-fb-save]')) {
    const msg = li.querySelector('[data-fb-savemsg]');
    const status = li.querySelector('[data-fb-status]').value;
    const reply = li.querySelector('[data-fb-reply]').value.trim() || null;
    msg.className = 'fb-msg'; msg.textContent = 'saving…';
    const { error } = await sb.from('feedback').update({ status, reply, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) { msg.className = 'fb-msg bad'; msg.textContent = error.message; return; }
    const row = fb.rows.find(r => r.id === id);
    Object.assign(row, { status, reply, updated_at: new Date().toISOString() });
    msg.className = 'fb-msg ok'; msg.textContent = 'saved';
    setTimeout(fbRender, 700);
  }
});

$('fbForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sb = fbClient();
  if (!sb) return;
  const title = $('fbTitleInput').value.trim(), details = $('fbDetails').value.trim();
  const msg = $('fbFormMsg');
  msg.className = 'fb-msg bad';
  if (title.length < 5) { msg.textContent = 'Give it a title of at least 5 characters.'; return; }
  if (details.length < 10) { msg.textContent = 'Add a few more details (at least 10 characters).'; return; }
  const hits = fbSensitive(title + '\n' + details);
  if (hits.length && !confirm(`Your request seems to contain ${hits.join(' and ')}.\n\nOther users can read requests on the board. Remove bank data before sending, or press OK to send it anyway.`)) return;
  $('fbSubmit').disabled = true;
  msg.className = 'fb-msg'; msg.textContent = 'sending…';
  const { error } = await sb.from('feedback').insert({ kind: $('fbKind').value, area: $('fbArea').value, impact: $('fbImpact').value, title, details });
  $('fbSubmit').disabled = false;
  if (error) {
    msg.className = 'fb-msg bad';
    msg.textContent = fbTableMissing(error) ? 'Feedback is not set up on this site yet.' : error.message;
    return;
  }
  $('fbForm').reset();
  msg.textContent = '';
  toast('Thanks — your request is on the board', 'ok');
  await fbLoad();
  fbTabs('mine');
});

// Show "updated" on the Feedback button after sign-in, without opening the dialog.
AGENT.ready.then(() => { if (AGENT.hosted) fbLoad().catch(() => {}); });

// ---------- Money side: what a transaction did in the core system (bank database, read-only) ----------
const bankDb = {};          // target id -> database settings as the agent reports them (never the password)
let moneyByKey = {};        // "index|followUp" -> money verdict for the latest load test
let lastResults = [];

async function loadBankDb(id) {
  const first = !(id in bankDb);
  try { bankDb[id] = await targetsApi('/api/bankdb?target=' + encodeURIComponent(id)); } catch (e) { bankDb[id] = null; }
  if (first) renderTargets();   // shows "money check" on the target row
  else renderMoneyButtons();
  return bankDb[id];
}
const moneyOn = (id) => { const x = id || (activeTarget() || {}).id; return !!(x && bankDb[x] && bankDb[x].configured); };
function renderMoneyButtons() {
  const on = moneyOn();
  $('moneyTrailBtn').hidden = !on;
  $('otTrailBtn').hidden = !on;
  $('moneyCheckBtn').hidden = !on || !currentJobId;
  $('moneyCheckBtn').disabled = !!pollTimer;
  $('switchReportBtn').hidden = !currentJobId;
  if (currentJobId) $('switchReportBtn').href = AGENT.link('/api/report?id=' + encodeURIComponent(currentJobId));
}

const MONEY_PILL = { PASS: ['ok', '✓ as expected'], FAIL: ['bad', '✗ problem'], WAIT: ['warn', '⏳ not posted yet'] };
function moneyPill(m, rrn) {
  if (!m) return '';
  const [cls, text] = MONEY_PILL[m.status] || ['neutral', '?'];
  const note = m.status === 'PASS' && m.note ? ' ⚠' : '';
  return `<button type="button" class="pill ${cls} mt-link" data-rrn="${escapeHtml(rrn || m.rrn || '')}" title="${escapeHtml(m.headline || '')}">${text}${note}</button>`;
}
function uatMoney(s, targetId) {
  if (!s.money) return '';
  const st = s.money.status;
  const cls = st === 'PASS' ? 'ok' : st === 'FAIL' ? 'bad' : st === 'WAIT' ? 'warn' : 'neutral';
  const mark = st === 'PASS' ? '✓' : st === 'FAIL' ? '✗' : st === 'WAIT' ? '⏳ not posted yet' : st === 'PENDING' ? 'checking…' : '?';
  const note = st === 'FAIL' || st === 'ERROR' || st === 'WAIT' ? ' ' + escapeHtml(s.money.headline || '')
    : s.money.note ? ` <span class="warn-t">⚠ ${escapeHtml(s.money.headline || '')}</span>` : '';
  return `<div class="sub money-line"><button type="button" class="pill ${cls} mt-link" data-rrn="${escapeHtml(s.rrn || '')}" data-target="${escapeHtml(targetId || '')}" title="${escapeHtml(s.money.headline || '')}">money ${mark}</button>${note}</div>`;
}

// Load test: look up every recent transaction once the run is over.
$('moneyCheckBtn').addEventListener('click', async () => {
  if (!currentJobId) return;
  const btn = $('moneyCheckBtn');
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const d = await targetsApi('/api/money/check-job?id=' + encodeURIComponent(currentJobId), {});
    moneyByKey = Object.fromEntries(d.results.map(r => [r.index + '|' + (r.followUp || ''), r]));
    renderResults(lastResults);
    const probs = Object.entries(d.problems || {}).sort((a, b) => b[1] - a[1]);
    const waits = Object.entries(d.waiting || {}).sort((a, b) => b[1] - a[1]);
    const notes = Object.entries(d.notes || {}).sort((a, b) => b[1] - a[1]);
    $('moneySum').innerHTML = `<b>Money side</b> of the latest ${d.checked} messages: <span class="ok-t">${d.pass} as expected</span>`
      + (d.fail ? ` · <span class="bad-t">${d.fail} problem${d.fail > 1 ? 's' : ''}</span>` : '')
      + (d.wait ? ` · <span class="warn-t">${d.wait} not posted yet</span>` : '')
      + (!d.fail && !d.wait && !notes.length ? '. Nothing wrong.' : '')
      + (probs.length || waits.length || notes.length ? `<ul>${probs.map(([k, n]) => `<li class="bad-t"><b>${n}×</b> ${escapeHtml(k)}</li>`).join('')}${waits.map(([k, n]) => `<li class="warn-t"><b>${n}×</b> ${escapeHtml(k)}</li>`).join('')}${notes.map(([k, n]) => `<li class="warn-t"><b>${n}×</b> ⚠ ${escapeHtml(k)}</li>`).join('')}</ul>` : '')
      + (d.wait ? '<p class="muted small">FLEXCUBE can post minutes after the switch approves, especially under load. Press Check money side again later.</p>' : '');
    $('moneySum').className = 'money-sum ' + (d.fail ? 'has-bad' : d.wait ? 'has-wait' : 'all-ok');
    $('moneySum').hidden = false;
  } catch (e) { toast(e.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = 'Check money side'; }
});

// Bank database settings per target.
let dbFor = null;
async function openDbDialog(t) {
  dbFor = t;
  $('dbTitle').textContent = 'Bank database · ' + t.name;
  $('dbMsg').textContent = '';
  $('dbTest').hidden = true;
  openTargets(false);
  $('dbDlg').showModal();
  const v = (await loadBankDb(t.id)) || {};
  $('dbHost').value = v.host || '';
  $('dbPort').value = v.port || 1521;
  $('dbService').value = v.service || '';
  $('dbSchema').value = v.schema || '';
  $('dbUser').value = v.user || '';
  $('dbPass').value = '';
  $('dbPass').placeholder = v.hasPassword ? 'saved · leave blank to keep' : '';
  $('dbMode').value = v.moneyCheck || 'report';
  $('dbRemove').hidden = !v.configured;
  $('dbDriverMsg').textContent = '';
  renderDriver(v);
  if (!can('money')) { $('dbMsg').className = 'fb-msg bad'; $('dbMsg').textContent = 'Money checks are part of the Enterprise plan.'; }
}

/** Which Oracle JDBC driver the agent uses and where it came from; the path box opens when none is found. */
function renderDriver(v) {
  const FROM = { chosen: 'the path you entered', settings: 'agent.properties', found: 'found automatically' };
  const missing = v.driverMissing ? `<span class="warn-t">The driver you entered is no longer there (${escapeHtml(v.driverMissing)}).</span> ` : '';
  $('dbDriver').innerHTML = v.driver
    ? `${missing}Oracle JDBC driver${v.driverVersion ? ' ' + escapeHtml(v.driverVersion) : ''}: <span class="mono">${escapeHtml(v.driver)}</span>
       <span class="muted">· ${FROM[v.driverSource] || ''}</span>
       <button type="button" class="link-btn" id="dbDriverChange">Change</button>
       ${v.driverSource === 'chosen' || v.driverMissing ? '<button type="button" class="link-btn" id="dbDriverAuto">Find automatically</button>' : ''}`
    : `${missing}<b>Oracle JDBC driver not found.</b> Install the Oracle client on this PC, or enter where <span class="mono">ojdbc8.jar</span> is.
       ${v.driverMissing ? '<button type="button" class="link-btn" id="dbDriverAuto">Find automatically</button>' : ''}`;
  $('dbDriver').className = 'db-driver' + (v.driver ? '' : ' bad');
  $('dbDriverEdit').hidden = !!v.driver;
  $('dbDriverPath').value = v.driverSource === 'chosen' ? v.driver : '';
}

async function setDriver(path) {
  $('dbDriverMsg').className = 'fb-msg'; $('dbDriverMsg').textContent = path ? 'loading the driver…' : 'searching…';
  try {
    const d = await targetsApi('/api/bankdb/driver', { path });
    if (bankDb[dbFor.id]) Object.assign(bankDb[dbFor.id], d);
    renderDriver(d);
    $('dbDriverMsg').className = 'fb-msg ok';
    $('dbDriverMsg').textContent = !d.driver ? '' : path ? `Using Oracle JDBC driver ${d.driverVersion || ''}`.trim() : 'Found automatically';
  } catch (e) { $('dbDriverMsg').className = 'fb-msg bad'; $('dbDriverMsg').textContent = e.message; }
}
$('dbDriver').addEventListener('click', (e) => {
  if (e.target.id === 'dbDriverChange') { $('dbDriverEdit').hidden = false; $('dbDriverPath').focus(); $('dbDriverPath').select(); }
  if (e.target.id === 'dbDriverAuto') setDriver('');
});
$('dbDriverUse').addEventListener('click', () => setDriver($('dbDriverPath').value.trim()));
$('dbDriverPath').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('dbDriverUse').click(); } });   // not the form's Save
const dbFormValues = () => ({
  target: dbFor.id, host: $('dbHost').value.trim(), port: $('dbPort').value, service: $('dbService').value.trim(),
  schema: $('dbSchema').value.trim(), user: $('dbUser').value.trim(), password: $('dbPass').value, moneyCheck: $('dbMode').value,
});
const DB_TABLES = { switchLog: 'Switch log (RRN → reference)', entries: 'Accounting entries', blocks: 'Amount blocks', balances: 'Balances (current, blocked, uncollected, available)', accounts: 'Accounts', history: 'Entry history (after end of day)', trnCodes: 'Transaction descriptions' };
$('dbTestBtn').addEventListener('click', async () => {
  $('dbMsg').className = 'fb-msg'; $('dbMsg').textContent = 'connecting…'; $('dbTest').hidden = true;
  try {
    const r = await targetsApi('/api/bankdb/test', dbFormValues());
    $('dbMsg').textContent = '';
    const need = ['switchLog', 'entries'];
    $('dbTest').innerHTML = r.error
      ? `<p class="bad"><b>Could not connect.</b> ${escapeHtml(r.error)}</p>`
      : `<p class="${r.ok ? 'ok' : 'bad'}"><b>${r.ok ? 'Connected' : 'Connected, but a required table is missing'}</b> as ${escapeHtml(r.connectedAs || '')} · ${escapeHtml(r.database || '')}</p>
         <ul class="db-tables">${Object.keys(DB_TABLES).map(k => { const n = (r.tables || {})[k]; return `<li class="${n ? 'ok' : need.includes(k) ? 'bad' : 'muted'}"><span>${DB_TABLES[k]}</span><span class="mono">${escapeHtml(n || (need.includes(k) ? 'not readable' : 'not readable · optional'))}</span></li>`; }).join('')}</ul>`;
    $('dbTest').hidden = false;
  } catch (e) { $('dbMsg').className = 'fb-msg bad'; $('dbMsg').textContent = e.message; }
});
$('dbForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    bankDb[dbFor.id] = await targetsApi('/api/bankdb', dbFormValues());
    $('dbPass').value = '';
    $('dbPass').placeholder = bankDb[dbFor.id].hasPassword ? 'saved · leave blank to keep' : '';
    $('dbRemove').hidden = false;
    $('dbMsg').className = 'fb-msg ok'; $('dbMsg').textContent = 'saved';
    renderTargets();
  } catch (err) { $('dbMsg').className = 'fb-msg bad'; $('dbMsg').textContent = err.message; }
});
$('dbRemove').addEventListener('click', async () => {
  if (!confirm(`Remove the bank database settings for ${dbFor.name}? Money checks stop for this target.`)) return;
  try {
    bankDb[dbFor.id] = await targetsApi('/api/bankdb', { target: dbFor.id, remove: true });
    $('dbDlg').close();
    renderTargets();
    toast('Bank database settings removed', 'ok');
  } catch (err) { toast(err.message, 'bad'); }
});
$('dbClose').addEventListener('click', () => $('dbDlg').close());

// A finished UAT run's money side, looked up again (e.g. once FLEXCUBE has caught up).
$('uatMoneyRecheck').addEventListener('click', async () => {
  if (!uatRunId) return;
  const btn = $('uatMoneyRecheck');
  btn.disabled = true; btn.textContent = 'Checking…';
  try { renderRun(await uatApi('/api/uat/money-recheck?id=' + encodeURIComponent(uatRunId), {})); toast('Money side checked again', 'ok'); }
  catch (e) { toast(e.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = 'Check money again'; }
});

// Money trail: every message, block, entry and balance for one RRN.
let trailTarget = null;
function openTrail(rrn, targetId) {
  trailTarget = targetId || (activeTarget() || {}).id;
  $('mtMsg').textContent = '';
  $('mtDlg').showModal();
  if (rrn) { $('mtRrn').value = rrn; lookupTrail(); }
  else { $('mtBody').innerHTML = ''; $('mtRrn').focus(); }
}
async function lookupTrail() {
  const rrn = $('mtRrn').value.trim();
  if (!rrn) return;
  $('mtMsg').className = 'fb-msg'; $('mtMsg').textContent = 'looking up…';
  try {
    const d = await targetsApi(`/api/money/trail?target=${encodeURIComponent(trailTarget || '')}&rrn=${encodeURIComponent(rrn)}`);
    $('mtMsg').textContent = '';
    renderTrail(d);
  } catch (e) { $('mtMsg').className = 'fb-msg bad'; $('mtMsg').textContent = e.message; $('mtBody').innerHTML = ''; }
}
const money2 = (v) => (v == null || v === '' ? '' : Number(v).toFixed(2));
// FLEXCUBE accounting events
const EVENTS = { INIT: 'Initiation', REVR: 'Reversal' };
const eventText = (e) => `<span title="Event ${escapeHtml(e)}">${escapeHtml(EVENTS[e] || e)}</span>`;
// Mini statement: each line of the reply next to the FLEXCUBE entry it points at.
function statementTable(lines, codes) {
  if (!lines || !lines.length) return '';
  const txn = (c) => `<span title="Transaction code ${escapeHtml(c)}">${escapeHtml((codes || {})[c] || c)}</span>`;
  const signed = (x) => (Number(x) < 0 ? '−' : '') + fmtAmt(Math.abs(Number(x)));
  const rows = lines.map((l, i) => {
    const e = l.entry;
    const amt = e ? (Number(e.fcy_amount) ? e.fcy_amount : e.lcy_amount) : null;
    return `<tr class="${l.match ? '' : 'row-bad'}">
      <td class="muted">${i + 1}</td>
      <td class="mono">${escapeHtml(l.valueDate)}</td><td>${txn(l.code)}</td><td>${l.drcr === 'D' ? 'Dr' : 'Cr'}</td><td class="num">${escapeHtml(signed(l.amount))}</td>
      <td class="mt-sep"></td>
      ${e ? `<td class="mono">${escapeHtml(e.trn_ref_no)}</td><td>${eventText(e.event)}</td><td>${txn(e.trn_code)}</td><td>${e.drcr_ind === 'D' ? 'Dr' : 'Cr'}</td><td class="num">${escapeHtml(signed(amt))}</td>`
          : '<td colspan="5" class="muted">no FLEXCUBE entry with this sequence</td>'}
      <td>${l.match ? '<span class="ok-t">✓</span>' : '<span class="bad-t">✗</span>'}</td>
    </tr>`;
  }).join('');
  return `<div class="table-wrap mt-stmt"><table class="tbl">
    <thead><tr><th>#</th><th colspan="4">Mini statement in the reply</th><th class="mt-sep"></th><th colspan="5">FLEXCUBE entry</th><th></th></tr>
    <tr><th></th><th>Value date</th><th>Transaction</th><th></th><th class="num">Amount</th><th class="mt-sep"></th><th>Reference</th><th>Event</th><th>Transaction</th><th></th><th class="num">Amount</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
// The FLEXCUBE switch logs times as YYYY:DD:MM hh:mm:ss.ffffff
const switchTime = (t) => { const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/.exec(t || ''); return m ? `${m[1]}-${m[3]}-${m[2]} ${m[4]}` : t; };
function renderTrail(d) {
  if (!d.messages.length) { $('mtBody').innerHTML = `<p class="fb-empty">The switch log on ${escapeHtml(d.target)} has no message with RRN ${escapeHtml(d.rrn)}.</p>`; return; }
  const msgs = d.verdicts.map((v, i) => {
    const m = d.messages[i];
    const ok = v.status === 'PASS';
    return `<li class="mt-msg ${ok ? '' : v.status === 'WAIT' ? 'is-wait' : 'is-bad'}">
      <div class="mt-msg-head">
        <span class="mono mt-mti">${escapeHtml(v.mti)}</span>
        <span class="mono muted">${escapeHtml(m.proc_code || '')}</span>
        <span class="mt-kind">${escapeHtml(v.label || '')}</span>
        <span class="pill ${OK_CODES.has(v.resp) ? 'ok' : 'bad'} code" title="${escapeHtml(CODE_DESC[v.resp] || '')}">${escapeHtml(v.resp || '—')}</span>
        <span class="pill ${ok ? 'ok' : v.status === 'WAIT' ? 'warn' : 'bad'}">${ok ? 'money ✓' : v.status === 'WAIT' ? 'money ⏳' : 'money ✗'}</span>
      </div>
      <ul class="mt-checks">${v.checks.map(c => `<li class="${c.ok === true ? 'ok' : c.ok === false ? 'bad' : c.wait ? 'wait' : c.warn ? 'warn' : 'muted'}">${escapeHtml(c.text)}</li>`).join('')}</ul>
      ${balanceLine(v.balances)}${statementTable(v.statement, d.trnCodes)}
      <div class="mt-meta mono">${[v.amount && 'amount ' + money2(v.amount), m.from_acc && 'from ' + m.from_acc, m.to_acc && 'to ' + m.to_acc,
        v.trnRef && 'ref ' + v.trnRef, v.block && 'block ' + v.block, v.switchError, m.db_in_time && 'logged ' + switchTime(m.db_in_time)].filter(Boolean).map(escapeHtml).join(' · ')}</div>
    </li>`;
  }).join('');
  const blocks = Object.values(d.blocks || {}).flat();
  const legs = Object.values(d.entries || {}).flat();
  const accts = Object.values(d.accounts || {});
  const table = (head, rows) => rows ? `<div class="table-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>` : '';
  const amtCell = (v) => (v == null || v === '' ? '<span class="muted">—</span>' : escapeHtml(fmtAmt(v)));
  $('mtBody').innerHTML = `<ol class="mt-msgs">${msgs}</ol>`
    + (blocks.length ? `<h3 class="mt-h">Amount blocks</h3>` + table('<th>Block</th><th>Account</th><th class="num">Amount</th><th>Status</th><th>Effective</th>',
        blocks.map(b => `<tr><td class="mono">${escapeHtml(b.amount_block_no)}</td><td class="mono">${escapeHtml(b.account)}</td><td class="num">${money2(b.amount)}</td><td>${b.record_stat === 'O' ? '<span class="pill warn">open</span>' : '<span class="pill neutral">closed</span>'}</td><td class="mono">${escapeHtml(String(b.effective_date || '').slice(0, 10))}</td></tr>`).join('')) : '')
    + (legs.length ? `<h3 class="mt-h">Accounting entries <span class="muted">customer accounts</span></h3>` + table('<th>Reference</th><th>Event</th><th>Account</th><th>Dr/Cr</th><th class="num">Amount</th><th>Ccy</th><th>Transaction</th><th>Value date</th>',
        legs.map(l => `<tr><td class="mono">${escapeHtml(l.trn_ref_no)}</td><td>${eventText(l.event)}</td><td class="mono">${escapeHtml(l.ac_no)}</td><td>${l.drcr_ind === 'D' ? 'Debit' : 'Credit'}</td><td class="num">${money2(Number(l.fcy_amount) ? l.fcy_amount : l.lcy_amount)}</td><td>${escapeHtml(l.ac_ccy)}</td><td title="Transaction code ${escapeHtml(l.trn_code)}">${escapeHtml((d.trnCodes || {})[l.trn_code] || l.trn_code)}</td><td class="mono">${escapeHtml(String(l.value_dt || '').slice(0, 10))}</td></tr>`).join('')) : '')
    + (accts.length ? `<h3 class="mt-h">Balances now</h3>` + table('<th>Account</th><th>Ccy</th><th class="num">Current</th><th class="num">Blocked</th><th class="num">Uncollected</th><th class="num">Available</th><th class="num">Net</th>',
        accts.map(a => `<tr><td class="mono">${escapeHtml(a.cust_ac_no)}</td><td>${escapeHtml(a.ccy)}</td><td class="num">${amtCell(a.current_balance)}</td><td class="num">${amtCell(a.blocked_amount)}</td><td class="num">${amtCell(a.uncollected)}</td><td class="num">${amtCell(a.available_balance)}</td><td class="num">${amtCell(a.net_bal)}</td></tr>`).join('')) : '');
}
$('mtForm').addEventListener('submit', (e) => { e.preventDefault(); lookupTrail(); });
$('mtClose').addEventListener('click', () => $('mtDlg').close());
$('moneyTrailBtn').addEventListener('click', () => openTrail());
$('otTrailBtn').addEventListener('click', () => openTrail());
document.addEventListener('click', (e) => {
  const b = e.target.closest('.mt-link[data-rrn]');
  if (b && b.dataset.rrn) openTrail(b.dataset.rrn, b.dataset.target || undefined);
});

// ---------- Plans: what this installation may use (licence from the SwitchProof website) ----------
const PLAN_NAMES = { free: 'Free', team: 'Team', enterprise: 'Enterprise', developer: 'Developer' };
let license = { plan: 'free', features: [], limits: { count: 200, concurrency: 5, uatCases: 10 }, featureNames: {} };
const can = (f) => (license.features || []).includes(f);

async function loadLicense() {
  try { license = await targetsApi('/api/license'); } catch (e) { /* keep what we had */ }
  renderPlan();
}

/** On the website: fetch this user's signed licence and hand it to the agent on this PC. */
let licenseProblem = null;
async function refreshLicense() {
  const sb = AGENT.hosted && AGENT.supabase ? AGENT.supabase() : null;
  if (sb) {
    try {
      const { data, error } = await sb.functions.invoke('license', { body: {} });
      if (error) throw error;
      if (data && data.token) {
        license = await targetsApi('/api/license', { token: data.token });
        licenseProblem = null;
        renderPlan();
        return;
      }
    } catch (e) { licenseProblem = (e && e.message) || String(e); }
  }
  await loadLicense();
}

function renderPlan() {
  const name = PLAN_NAMES[license.plan] || license.plan;
  const b = $('planBtn');
  b.textContent = name;
  b.className = 'plan-badge p-' + license.plan;
  b.title = license.expires ? `${name} plan until ${license.expires}` : `${name} plan`;
  document.querySelector('.mode-tab[data-mode="bundle"]').classList.toggle('locked', !can('bundles'));
  $('bundleLock').hidden = can('bundles') || mode !== 'bundle';
  const lim = license.limits || {};
  $('freeLimits').hidden = can('unlimited');
  $('freeLimits').textContent = `Free: up to ${lim.count} per run, ${lim.concurrency} at once`;
  $('uatLimit').hidden = can('uat');
  $('uatLimit').textContent = `Free: up to ${lim.uatCases} cases per run`;
  if ($('planDlg').open) renderPlanDialog();
}

function renderPlanDialog() {
  const name = PLAN_NAMES[license.plan] || license.plan;
  $('planTitle').textContent = name;
  const sub = [];
  if (license.plan === 'developer') sub.push('Developer build: every feature is on.');
  else if (license.plan === 'free') sub.push('Free: load tests, open transactions and UAT runs within the limits below.');
  else sub.push(`${name}${license.expires ? ' until ' + license.expires : ''}${license.source ? ' · ' + license.source : ''}.`);
  if (license.email && license.plan !== 'developer') sub.push('Signed in as ' + license.email + '.');
  $('planSub').innerHTML = sub.map(escapeHtml).join(' ')
    + (license.rejected ? `<br><span class="warn-t">${escapeHtml(license.rejected)}</span>` : '')
    + (licenseProblem && fb.admin ? `<br><span class="warn-t">Licence service: ${escapeHtml(licenseProblem)} (deploy the "license" Edge Function)</span>` : '');
  const names = license.featureNames || {};
  const lim = license.limits || {};
  $('planFeatures').innerHTML = Object.entries(names).map(([k, n]) => {
    const on = can(k);
    const need = k === 'money' ? 'Enterprise' : 'Team';
    return `<li class="${on ? 'on' : 'off'}">${escapeHtml(n)}${on ? '' : ` <span class="muted">· ${need}</span>`}</li>`;
  }).join('') + (can('unlimited') ? '' : `<li class="note">Free load tests: up to ${lim.count} per run, ${lim.concurrency} at once. UAT: up to ${lim.uatCases} cases per run.</li>`);
  $('planCodeForm').hidden = !AGENT.hosted;
  $('planLocal').hidden = AGENT.hosted || license.plan === 'developer';
  renderOffers();
}

function showUpgrade(d) {
  const plan = String(d.plan || 'Team').toLowerCase();
  const card = canBuy(plan);
  $('upTitle').textContent = `Part of the ${PLAN_NAMES[plan] || d.plan} plan`;
  $('upText').textContent = d.error || '';
  $('upHow').textContent = !AGENT.hosted ? 'Plans come with your SwitchProof account on the SwitchProof website.'
    : card ? `Buy ${PLAN_NAMES[plan]} by card now, talk to us for an invoice, or enter an invite code under My plan.`
    : 'Talk to us for a price, or enter an invite code under My plan.';
  $('upBuy').hidden = !card;
  $('upBuy').textContent = `Buy ${PLAN_NAMES[plan]} by card`;
  $('upBuy').dataset.plan = plan;
  $('upQuote').hidden = !AGENT.hosted;
  $('upQuote').dataset.plan = plan;
  $('upOk').hidden = card;
  if (!$('upgradeDlg').open) $('upgradeDlg').showModal();
}

// ---------- Buying: card checkout (Paddle) and "Talk to us" requests ----------
// The browser only opens the checkout. The plan is granted by the paddle-webhook Edge Function after
// Paddle confirms the payment, from the price that was paid, and reaches this PC as a signed licence.
const paddleCfg = () => (window.SWITCHPROOF_CONFIG || {}).paddle || null;
const PLAN_RANK = { free: 0, team: 1, enterprise: 2, developer: 3 };
const OFFERS = {
  team: 'Unlimited load tests, bundles, full UAT runs, printable reports and every ISO 8583 format.',
  enterprise: 'Everything in Team, plus money checks: blocks, postings and balances read from the bank database.',
};
const prices = {};          // plan -> "US$100.00 / month · 7-day free trial", from Paddle
let paddleLoading = null, buying = null;
const canBuy = (plan) => { const c = paddleCfg(); return !!(AGENT.hosted && c && c.token && c.prices && c.prices[plan]); };
const daysLeft = (day) => day ? Math.ceil((Date.parse(day + 'T23:59:59') - Date.now()) / 86400e3) : Infinity;

function loadPaddle() {
  const cfg = paddleCfg();
  const start = () => {
    if (cfg.environment === 'sandbox') window.Paddle.Environment.set('sandbox');
    window.Paddle.Initialize({ token: cfg.token, eventCallback: paddleEvent });
    return window.Paddle;
  };
  if (!paddleLoading) paddleLoading = new Promise((resolve, reject) => {
    if (window.Paddle && window.Paddle.Checkout) { resolve(start()); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
    s.onload = () => { try { resolve(start()); } catch (e) { reject(e); } };
    s.onerror = () => reject(new Error('The card checkout could not load. Check the internet connection, or use Talk to us.'));
    document.head.appendChild(s);
  }).catch((e) => { paddleLoading = null; throw e; });
  return paddleLoading;
}

async function loadPrices() {
  const cfg = paddleCfg();
  if (!cfg || Object.keys(prices).length) return;
  try {
    const P = await loadPaddle();
    const ids = Object.values(cfg.prices).filter(Boolean);
    const r = await P.PricePreview({ items: ids.map(priceId => ({ priceId, quantity: 1 })) });
    const lines = (r && r.data && r.data.details && r.data.details.lineItems) || [];
    for (const li of lines) {
      const plan = Object.keys(cfg.prices).find(k => li.price && cfg.prices[k] === li.price.id);
      const cyc = li.price && li.price.billingCycle;
      const per = cyc ? ' / ' + (cyc.frequency > 1 ? `${cyc.frequency} ${cyc.interval}s` : cyc.interval) : '';
      const t = li.price && li.price.trialPeriod;
      const trial = !t ? '' : ` · ${t.interval === 'week' ? 7 * (t.frequency || 1) + '-day' : (t.frequency || 1) + '-' + t.interval} free trial`;
      if (plan && li.formattedTotals) prices[plan] = li.formattedTotals.total + per + trial;
    }
    renderOffers();
  } catch (e) { /* prices are shown in the checkout anyway */ }
}

function renderOffers() {
  const show = AGENT.hosted && license.plan !== 'developer';
  $('planBuy').hidden = !show;
  if (!show) return;
  const mine = PLAN_RANK[license.plan] || 0;
  const renew = daysLeft(license.expires) <= 30 && license.source !== 'Paid by card';
  $('planOffers').innerHTML = ['team', 'enterprise']
    .filter(p => PLAN_RANK[p] > mine || (PLAN_RANK[p] === mine && renew))
    .map(p => {
      const again = PLAN_RANK[p] === mine;
      return `<div class="plan-offer">
        <div class="plan-offer-head"><strong>${again ? 'Renew ' : ''}${PLAN_NAMES[p]}</strong><span class="plan-price mono">${escapeHtml(prices[p] || '')}</span></div>
        <p>${escapeHtml(OFFERS[p])}</p>
        ${canBuy(p) ? `<button type="button" class="btn primary sm" data-buy="${p}">${again ? 'Renew' : 'Buy'} by card</button>`
                    : `<button type="button" class="btn ghost sm" data-quote="${p}">Ask for a price</button>`}
      </div>`;
    }).join('');
  if (canBuy('team') || canBuy('enterprise')) loadPrices();
}

async function signedInUser() {
  const sb = AGENT.supabase && AGENT.supabase();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data && data.session ? data.session.user : null;
}

async function buy(plan) {
  if (!canBuy(plan)) return openQuote(plan);
  const user = await signedInUser();
  if (!user) { toast('Sign in again to buy a plan', 'bad'); return; }
  let P;
  try { P = await loadPaddle(); } catch (e) { toast(e.message, 'bad'); return; }
  // The checkout sits outside our dialogs; an open modal dialog would cover it and block its clicks.
  ['planDlg', 'upgradeDlg'].forEach(id => { if ($(id).open) $(id).close(); });
  buying = { plan, done: false };
  P.Checkout.open({
    items: [{ priceId: paddleCfg().prices[plan], quantity: 1 }],
    customer: { email: user.email },
    customData: { email: user.email, user_id: user.id },   // the webhook grants the plan to this account
  });
}

function paddleEvent(ev) {
  if (!ev || !buying) return;
  if (ev.name === 'checkout.completed' && !buying.done) { buying.done = true; waitForPlan(buying.plan); }
  if (ev.name === 'checkout.closed' && !buying.done) buying = null;
}

/** Payment done: the webhook usually grants the plan within seconds. Show it as soon as it arrives. */
async function waitForPlan(plan) {
  toast(`Thank you. Turning on ${PLAN_NAMES[plan]}…`, 'ok');
  for (let i = 0; i < 24; i++) {
    await new Promise(r => setTimeout(r, i < 6 ? 2500 : 5000));
    await refreshLicense();
    if ((PLAN_RANK[license.plan] || 0) >= PLAN_RANK[plan]) {
      buying = null;
      toast(`${PLAN_NAMES[license.plan]} is on. Thank you!`, 'ok');
      $('planBtn').click();
      return;
    }
  }
  buying = null;
  toast('Your order went through, but the plan has not arrived yet. It can take a few minutes: check My plan later, or use Talk to us.', 'bad');
}

async function openQuote(plan) {
  if (!(AGENT.supabase && AGENT.supabase())) return;
  ['planDlg', 'upgradeDlg'].forEach(id => { if ($(id).open) $(id).close(); });
  const user = await signedInUser();
  $('quoteEmail').textContent = (user && user.email) || license.email || 'your account email';
  $('quotePlan').value = plan || ((PLAN_RANK[license.plan] || 0) >= 1 ? 'enterprise' : 'team');
  $('quoteMsg').className = 'fb-msg'; $('quoteMsg').textContent = '';
  $('quoteSend').hidden = false; $('quoteCancel').textContent = 'Cancel';
  $('quoteDlg').showModal();
  $('quoteCompany').focus();
}

$('quoteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const testers = $('quoteTesters').value ? Number($('quoteTesters').value) : null;
  const row = { company: $('quoteCompany').value.trim(), plan: $('quotePlan').value, testers, message: $('quoteMessage').value.trim() || null };
  if (row.company.length < 2) { $('quoteMsg').className = 'fb-msg bad'; $('quoteMsg').textContent = 'Enter your company or bank'; return; }
  $('quoteSend').disabled = true;
  $('quoteMsg').className = 'fb-msg'; $('quoteMsg').textContent = 'Sending…';
  const { error } = await AGENT.supabase().from('sales_requests').insert(row);
  $('quoteSend').disabled = false;
  if (error) {
    $('quoteMsg').className = 'fb-msg bad';
    $('quoteMsg').textContent = fbTableMissing(error) ? 'Requests are not set up on this site yet.' : error.message;
    return;
  }
  ['quoteCompany', 'quoteTesters', 'quoteMessage'].forEach(id => { $(id).value = ''; });
  $('quoteMsg').className = 'fb-msg ok';
  $('quoteMsg').textContent = `Sent. We'll reply to ${$('quoteEmail').textContent}.`;
  $('quoteSend').hidden = true; $('quoteCancel').textContent = 'Close';
});
['quoteClose', 'quoteCancel'].forEach(id => $(id).addEventListener('click', () => $('quoteDlg').close()));
$('planQuote').addEventListener('click', () => openQuote());
$('planOffers').addEventListener('click', (e) => {
  const b = e.target.closest('[data-buy],[data-quote]');
  if (b && b.dataset.buy) buy(b.dataset.buy);
  else if (b) openQuote(b.dataset.quote);
});
$('upBuy').addEventListener('click', () => buy($('upBuy').dataset.plan));
$('upQuote').addEventListener('click', () => openQuote($('upQuote').dataset.plan));

$('planBtn').addEventListener('click', async () => {
  $('planMsg').textContent = '';
  renderPlanDialog();
  $('planDlg').showModal();
  await refreshLicense();
  renderPlanDialog();
});
$('planClose').addEventListener('click', () => $('planDlg').close());
$('planRefresh').addEventListener('click', async () => {
  $('planMsg').className = 'fb-msg'; $('planMsg').textContent = 'checking…';
  await refreshLicense();
  $('planMsg').textContent = 'up to date';
});
$('planCodeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('planCode').value.trim().toUpperCase();
  const sb = AGENT.supabase && AGENT.supabase();
  if (!code || !sb) return;
  $('planMsg').className = 'fb-msg'; $('planMsg').textContent = 'checking the code…';
  const { error } = await sb.rpc('redeem_code', { p_code: code });
  if (error) { $('planMsg').className = 'fb-msg bad'; $('planMsg').textContent = error.message; return; }
  await refreshLicense();
  $('planCode').value = '';
  $('planMsg').className = 'fb-msg ok';
  $('planMsg').textContent = `Code accepted: ${PLAN_NAMES[license.plan] || license.plan}${license.expires ? ' until ' + license.expires : ''}`;
  renderPlanDialog();
});
$('planTokenBtn').addEventListener('click', async () => {
  const token = $('planToken').value.trim();
  if (!token) return;
  try {
    license = await targetsApi('/api/license', { token });
    $('planToken').value = '';
    $('planMsg').className = 'fb-msg ok'; $('planMsg').textContent = 'Licence accepted';
    renderPlan(); renderPlanDialog();
  } catch (err) { $('planMsg').className = 'fb-msg bad'; $('planMsg').textContent = err.message; }
});
['upClose', 'upOk'].forEach(id => $(id).addEventListener('click', () => $('upgradeDlg').close()));
$('upPlan').addEventListener('click', () => { $('upgradeDlg').close(); $('planBtn').click(); });

// ---------- Access (admins, on the website): plan grants and invite codes ----------
const acc = { grants: [], codes: [], redeemed: [], sales: [], payments: [], tab: 'grants' };
const siteUrl = () => location.origin + location.pathname;
const dayEnd = (d) => new Date(d + 'T23:59:59').toISOString();
// Shown in the viewer's own time zone: "until 25 Dec" means the end of 25 Dec where you are.
const dayOf = (iso) => { const d = new Date(iso); if (!iso || isNaN(d)) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
function newCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O/1/I to misread
  const r = crypto.getRandomValues(new Uint8Array(8));
  const part = (i) => Array.from(r.slice(i, i + 4), (x) => abc[x % abc.length]).join('');
  return `SP-${part(0)}-${part(4)}`;
}
function accMsg(text, kind) { $('accMsg').className = 'fb-msg ' + (kind || ''); $('accMsg').textContent = text || ''; }

/** quiet: just refresh the counts on the Access button (on start, for admins). */
async function accLoad(quiet) {
  const sb = AGENT.supabase && AGENT.supabase();
  if (!sb) return;
  if (!quiet) accMsg('Loading…');
  const [g, c, r, s, p] = await Promise.all([
    sb.from('license_grants').select('*').order('created_at', { ascending: false }),
    sb.from('license_codes').select('*').order('created_at', { ascending: false }),
    sb.rpc('admin_redemptions'),
    sb.from('sales_requests').select('*').order('created_at', { ascending: false }).limit(500),
    sb.from('license_purchases').select('*').order('created_at', { ascending: false }).limit(200),
  ]);
  const err = g.error || c.error || r.error || s.error || p.error;
  if (err) { if (!quiet) accMsg(fbTableMissing(err) ? 'Plans are not set up yet: run tools/supabase-licensing.sql in Supabase.' : err.message, 'bad'); return; }
  acc.grants = g.data || []; acc.codes = c.data || []; acc.redeemed = r.data || [];
  acc.sales = s.data || []; acc.payments = p.data || [];
  if (!quiet) accMsg('');
  accRender();
}

/** Plans ending in the next 30 days or ended in the last 30: grants, and invite-code trials nobody has replaced. */
function renewals() {
  const now = Date.now(), win = 30 * 86400e3;
  const near = (iso) => { const t = Date.parse(iso); return t > now - win && t < now + win; };
  const covered = (email, after) => acc.grants.some(g => Date.parse(g.expires_at) > Date.parse(after)
    && (g.kind === 'email' ? g.value === email : email.endsWith('@' + g.value)));
  const codePlan = (code) => { const k = acc.codes.find(x => x.code === code); return k ? k.plan : 'team'; };
  const rows = [];
  for (const g of acc.grants) {
    if (!near(g.expires_at)) continue;
    const sub = g.origin === 'card' && /\bsub_/.test(g.note || '');
    rows.push({ kind: 'grant', id: g.id, who: (g.kind === 'domain' ? 'Everyone @' : '') + g.value, email: g.kind === 'email' ? g.value : null,
      plan: g.plan, ends: g.expires_at, card: g.origin === 'card', auto: sub,
      how: sub ? 'Card subscription: renews by itself' : g.origin === 'card' ? 'Paid by card, one payment' : 'Your grant' + (g.note ? ` (${g.note})` : '') });
  }
  for (const r of acc.redeemed) {
    if (!r.email || !near(r.expires_at) || covered(r.email, r.expires_at)) continue;
    rows.push({ kind: 'code', who: r.email, email: r.email, plan: codePlan(r.code), ends: r.expires_at, how: 'Invite code ' + r.code });
  }
  return rows.sort((a, b) => Date.parse(a.ends) - Date.parse(b.ends));
}
const needsReminder = (x) => !x.auto && Date.parse(x.ends) > Date.now();
function whenText(iso) {
  const d = Math.round((Date.parse(iso) - Date.now()) / 86400e3);
  return d > 1 ? `in ${d} days` : d === 1 ? 'tomorrow' : d === 0 ? 'today' : d === -1 ? 'yesterday' : `${-d} days ago`;
}
function reminderText(x) {
  const plan = PLAN_NAMES[x.plan] || x.plan, day = dayOf(x.ends), ended = Date.parse(x.ends) <= Date.now();
  const what = x.kind === 'code' ? `SwitchProof ${plan} trial` : `SwitchProof ${plan} plan`;
  const keep = canBuy(x.plan)
    ? `sign in at ${siteUrl()}, click the plan badge (top right) and buy ${plan} by card, or reply to this email for an invoice.`
    : `reply to this email and we'll send you an invoice.`;
  return ended ? `Hi,\n\nYour ${what} ended on ${day}, so SwitchProof is back on Free. To turn ${plan} on again, ${keep}\n\nThank you for using SwitchProof.`
    : `Hi,\n\nYour ${what} ends on ${day}. To keep it, ${keep}\n\nThank you for using SwitchProof.`;
}
function money(amount, ccy) {
  if (amount == null || !ccy) return '';
  try {
    const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: ccy });
    return f.format(Number(amount) / Math.pow(10, f.resolvedOptions().maximumFractionDigits));   // Paddle sends minor units
  } catch (e) { return `${amount} ${ccy}`; }
}
const mailto = (email, subject, body) => `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

function accBadge() {
  const fresh = acc.sales.filter(s => s.status === 'new').length;
  const soon = renewals().filter(x => needsReminder(x) && Date.parse(x.ends) < Date.now() + 7 * 86400e3).length;
  const n = fresh + soon;
  $('accBadge').hidden = !n;
  $('accBadge').textContent = n;
  const why = [fresh && `${fresh} new sales request${fresh === 1 ? '' : 's'}`, soon && `${soon} plan${soon === 1 ? '' : 's'} ending this week`].filter(Boolean);
  $('accessOpen').title = why.length ? why.join(' · ') : 'Grant plans and make invite codes';
  acctDot();
}

/** Prefill the grant form, e.g. after an invoice is paid. */
function grantFor(email, plan) {
  accTabs('grants');
  $('grantKind').value = 'email'; $('grantKind').dispatchEvent(new Event('change'));
  $('grantValue').value = email;
  $('grantPlan').value = plan === 'enterprise' ? 'enterprise' : 'team';
  $('grantUntil').value = inDays(365);
  $('grantNote').value = 'Invoice';
  $('grantNote').focus();
  accMsg('Check the dates and note, then Save grant', 'ok');
}

function accTabs(tab) {
  acc.tab = tab;
  document.querySelectorAll('[data-acc-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.accTab === tab)));
  document.querySelectorAll('[data-acc-pane]').forEach(p => { p.hidden = p.dataset.accPane !== tab; });
}

function accRender() {
  const now = Date.now();
  $('grantList').innerHTML = acc.grants.length ? acc.grants.map(g => {
    const live = Date.parse(g.expires_at) > now;
    return `<tr class="${live ? '' : 'row-muted'}" data-id="${g.id}">
      <td>${g.kind === 'domain' ? 'Everyone @' : ''}${escapeHtml(g.value)}</td>
      <td>${escapeHtml(PLAN_NAMES[g.plan] || g.plan)}</td>
      <td class="mono">${escapeHtml(dayOf(g.expires_at))}${live ? '' : ' <span class="muted">ended</span>'}</td>
      <td>${escapeHtml(g.note || '')}</td>
      <td class="acc-actions">
        <button type="button" class="link-btn" data-acc="copy-grant">Copy message</button>
        ${g.kind === 'email' ? '<button type="button" class="link-btn" data-acc="invite">Send invite email</button>' : ''}
        <button type="button" class="link-btn danger" data-acc="del-grant">Remove</button>
      </td></tr>`;
  }).join('') : '<tr><td colspan="5" class="muted">No grants yet.</td></tr>';

  const used = {};
  for (const r of acc.redeemed) used[r.code] = (used[r.code] || 0) + 1;
  $('codeList').innerHTML = acc.codes.length ? acc.codes.map(k => {
    const live = Date.parse(k.valid_until) > now && (used[k.code] || 0) < k.max_uses;
    return `<tr class="${live ? '' : 'row-muted'}" data-code="${escapeHtml(k.code)}">
      <td class="mono">${escapeHtml(k.code)}</td>
      <td>${escapeHtml(PLAN_NAMES[k.plan] || k.plan)}</td>
      <td class="num">${k.days}</td>
      <td class="num">${used[k.code] || 0} / ${k.max_uses}</td>
      <td class="mono">${escapeHtml(dayOf(k.valid_until))}${live ? '' : ' <span class="muted">closed</span>'}</td>
      <td>${escapeHtml(k.note || '')}</td>
      <td class="acc-actions">
        <button type="button" class="link-btn" data-acc="copy-code">Copy message</button>
        ${live ? '<button type="button" class="link-btn" data-acc="end-code">End now</button>' : ''}
        <button type="button" class="link-btn danger" data-acc="del-code">Delete</button>
      </td></tr>`;
  }).join('') : '<tr><td colspan="7" class="muted">No codes yet.</td></tr>';

  $('redeemList').innerHTML = acc.redeemed.length ? acc.redeemed.map(r => `<tr data-code="${escapeHtml(r.code)}" data-user="${escapeHtml(r.user_id)}">
      <td class="mono">${escapeHtml(r.code)}</td><td>${escapeHtml(r.email || '')}</td>
      <td class="mono">${escapeHtml(dayOf(r.redeemed_at))}</td><td class="mono">${escapeHtml(dayOf(r.expires_at))}</td>
      <td class="acc-actions"><button type="button" class="link-btn danger" data-acc="del-redeem" title="Ends this person's plan from this code">Remove</button></td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">Nobody has redeemed a code yet.</td></tr>';

  const ren = renewals();
  acc.renewals = ren;
  $('renewCount').textContent = ren.filter(needsReminder).length || '';
  $('renewList').innerHTML = ren.length ? ren.map((x, i) => {
    const ended = Date.parse(x.ends) <= now;
    const subj = `Your SwitchProof ${PLAN_NAMES[x.plan]} ${x.kind === 'code' ? 'trial' : 'plan'} ${ended ? 'has ended' : 'ends ' + dayOf(x.ends)}`;
    return `<tr class="${ended || x.auto ? 'row-muted' : ''}" data-i="${i}">
      <td>${escapeHtml(x.who)}</td>
      <td>${escapeHtml(PLAN_NAMES[x.plan] || x.plan)}</td>
      <td><span class="mono">${escapeHtml(dayOf(x.ends))}</span> <span class="${ended ? 'muted' : Date.parse(x.ends) < now + 7 * 86400e3 ? 'warn-t' : 'muted'}">${whenText(x.ends)}</span></td>
      <td class="wrap">${escapeHtml(x.how)}</td>
      <td class="acc-actions">
        ${x.email && !x.auto ? `<a class="link-btn" href="${escapeHtml(mailto(x.email, subj, reminderText(x)))}">Email</a>
          <button type="button" class="link-btn" data-acc="copy-reminder" title="Copy the reminder text">Copy</button>` : ''}
        ${x.kind === 'grant' && !x.card ? '<button type="button" class="link-btn" data-acc="extend">Extend 1 year</button>' : ''}
        ${x.kind === 'code' ? '<button type="button" class="link-btn" data-acc="grant-for" title="Give this email a plan, e.g. once their invoice is paid">Grant</button>' : ''}
      </td></tr>`;
  }).join('') : '<tr><td colspan="5" class="muted">No plans end in the next 30 days.</td></tr>';

  const fresh = acc.sales.filter(s => s.status === 'new').length;
  $('salesCount').textContent = fresh || '';
  const STATUS = { new: 'New', contacted: 'Contacted', won: 'Won', lost: 'Lost' };
  $('salesList').innerHTML = acc.sales.length ? acc.sales.map(s => `<tr class="${s.status === 'won' || s.status === 'lost' ? 'row-muted' : ''}" data-id="${s.id}">
      <td class="mono">${escapeHtml(dayOf(s.created_at))}</td>
      <td><strong>${escapeHtml(s.company)}</strong><br><span class="muted">${escapeHtml(s.email || '')}</span></td>
      <td>${escapeHtml(PLAN_NAMES[s.plan] || 'Not sure')}</td>
      <td class="num">${s.testers || ''}</td>
      <td class="sales-msg">${escapeHtml(s.message || '')}</td>
      <td><select class="sales-status" data-acc="status" aria-label="Status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === s.status ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
      <td class="acc-actions">
        ${s.email ? `<a class="link-btn" href="${escapeHtml(mailto(s.email, 'SwitchProof ' + (PLAN_NAMES[s.plan] || 'plans') + ' for ' + s.company, 'Hi,\n\nThank you for asking about SwitchProof.\n\n'))}">Reply</a>
          <button type="button" class="link-btn" data-acc="grant-sale" title="Give this email a plan, e.g. once their invoice is paid">Grant</button>` : ''}
      </td></tr>`).join('')
    : '<tr><td colspan="7" class="muted">No requests yet. They arrive from "Talk to us" in My plan.</td></tr>';

  $('payList').innerHTML = acc.payments.length ? acc.payments.map(p => `<tr>
      <td class="mono">${escapeHtml(dayOf(p.created_at))}</td>
      <td>${escapeHtml(p.email || '')}</td>
      <td>${escapeHtml(PLAN_NAMES[p.plan] || p.plan || '')}</td>
      <td class="num">${escapeHtml(money(p.amount, p.currency))}</td>
      <td class="mono">${escapeHtml(dayOf(p.paid_until))}</td>
      <td class="wrap">${escapeHtml(p.outcome || '')}</td></tr>`).join('')
    : `<tr><td colspan="6" class="muted">${paddleCfg() ? 'No card payments yet.' : 'Card checkout is off: build the site with -PaddleToken to turn it on.'}</td></tr>`;
  accBadge();
}

function inviteText(kind, v) {
  if (kind === 'email') return `You have SwitchProof ${PLAN_NAMES[v.plan]} until ${dayOf(v.expires_at)}.\n\n1. Go to ${siteUrl()}\n2. Create an account (or sign in) with ${v.value}\n3. Download SwitchProof for Windows from the site and open it.`;
  if (kind === 'domain') return `Everyone with an @${v.value} email address has SwitchProof ${PLAN_NAMES[v.plan]} until ${dayOf(v.expires_at)}.\n\nSign up at ${siteUrl()} with your work email, then download SwitchProof for Windows from the site.`;
  return `Your SwitchProof invite code: ${v.code} (${PLAN_NAMES[v.plan]} for ${v.days} days).\n\n1. Go to ${siteUrl()} and create an account\n2. Click the plan badge (top right) and enter the code\n3. Download SwitchProof for Windows from the site and open it.`;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied: paste it into an email or chat', 'ok'); }
  catch (e) { prompt('Copy this message:', text); }
}

$('accessOpen').addEventListener('click', async () => {
  $('grantUntil').value = inDays(90);
  $('codeUntil').value = inDays(30);
  $('codeValue').value = newCode();
  accTabs(acc.tab);
  $('accessDlg').showModal();
  await accLoad();
});
$('accClose').addEventListener('click', () => $('accessDlg').close());
document.querySelector('#accessDlg .fb-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-acc-tab]'); if (b) accTabs(b.dataset.accTab); });
$('grantKind').addEventListener('change', () => {
  const dom = $('grantKind').value === 'domain';
  $('grantValueLabel').textContent = dom ? 'Domain' : 'Email';
  $('grantValue').placeholder = dom ? 'yourbank.com' : 'name@example.com';
});

$('grantForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = $('grantKind').value;
  const value = $('grantValue').value.trim().toLowerCase().replace(/^@/, '');
  if (kind === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) { accMsg('Enter an email address', 'bad'); return; }
  if (kind === 'domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) { accMsg('Enter a domain like yourbank.com', 'bad'); return; }
  const row = { kind, value, plan: $('grantPlan').value, expires_at: dayEnd($('grantUntil').value), note: $('grantNote').value.trim() || null };
  const { error } = await AGENT.supabase().from('license_grants').upsert(row, { onConflict: 'kind,value' });
  if (error) { accMsg(error.message, 'bad'); return; }
  $('grantValue').value = ''; $('grantNote').value = '';
  await accLoad();
  accMsg(`Saved: ${kind === 'domain' ? 'everyone @' : ''}${value} has ${PLAN_NAMES[row.plan]} until ${dayOf(row.expires_at)}`, 'ok');
});

$('codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const row = { code: $('codeValue').value.trim().toUpperCase(), plan: $('codePlan').value, days: Number($('codeDays').value),
    max_uses: Number($('codeUses').value), valid_until: dayEnd($('codeUntil').value), note: $('codeNote').value.trim() || null };
  if (!/^[A-Z0-9-]{6,32}$/.test(row.code)) { accMsg('Codes use letters, digits and dashes (6-32 characters)', 'bad'); return; }
  const { error } = await AGENT.supabase().from('license_codes').insert(row);
  if (error) { accMsg(/duplicate|unique/i.test(error.message) ? 'That code already exists' : error.message, 'bad'); return; }
  $('codeValue').value = newCode(); $('codeNote').value = '';
  await accLoad();
  accMsg(`Created ${row.code}: copy its message to share it`, 'ok');
});

document.querySelector('#accessDlg').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-acc]');
  if (!b) return;
  const sb = AGENT.supabase();
  const tr = b.closest('tr');
  const act = b.dataset.acc;
  let res;
  if (act === 'status') return;   // handled on change
  if (act === 'copy-reminder') return copyText(reminderText(acc.renewals[Number(tr.dataset.i)]));
  if (act === 'grant-for') { const x = acc.renewals[Number(tr.dataset.i)]; return grantFor(x.email, x.plan); }
  if (act === 'grant-sale') { const s = acc.sales.find(x => String(x.id) === tr.dataset.id); return grantFor(s.email, s.plan); }
  if (act === 'extend') {
    const x = acc.renewals[Number(tr.dataset.i)];
    const until = new Date(Math.max(Date.parse(x.ends), Date.now()) + 365 * 86400e3).toISOString();
    if (!confirm(`Extend ${x.who} (${PLAN_NAMES[x.plan]}) to ${dayOf(until)}?`)) return;
    res = await sb.from('license_grants').update({ expires_at: until }).eq('id', x.id);
    if (!res.error) { await accLoad(); accMsg(`${x.who} now has ${PLAN_NAMES[x.plan]} until ${dayOf(until)}`, 'ok'); return; }
  }
  if (act === 'copy-grant') { const g = acc.grants.find(x => String(x.id) === tr.dataset.id); return copyText(inviteText(g.kind, g)); }
  if (act === 'copy-code') { const k = acc.codes.find(x => x.code === tr.dataset.code); return copyText(inviteText('code', k)); }
  if (act === 'invite') {
    const g = acc.grants.find(x => String(x.id) === tr.dataset.id);
    accMsg('Sending…');
    const { data, error } = await sb.functions.invoke('admin-invite', { body: { email: g.value } });
    if (error || (data && data.error)) accMsg('Invite email not sent: ' + ((data && data.error) || error.message) + '. You can copy the message instead.', 'bad');
    else accMsg('Invite email sent to ' + g.value, 'ok');
    return;
  }
  if (act === 'del-grant') { if (!confirm('Remove this grant? They go back to Free (or another grant or code).')) return; res = await sb.from('license_grants').delete().eq('id', Number(tr.dataset.id)); }
  if (act === 'end-code') res = await sb.from('license_codes').update({ valid_until: new Date().toISOString() }).eq('code', tr.dataset.code);
  if (act === 'del-code') { if (!confirm('Delete this code? Everyone who redeemed it loses the plan it gave them.')) return; res = await sb.from('license_codes').delete().eq('code', tr.dataset.code); }
  if (act === 'del-redeem') { if (!confirm('Remove this redemption? That person goes back to Free (or another grant).')) return; res = await sb.from('license_redemptions').delete().eq('code', tr.dataset.code).eq('user_id', tr.dataset.user); }
  if (res && res.error) { accMsg(res.error.message, 'bad'); return; }
  await accLoad();
});
document.querySelector('#accessDlg').addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-acc="status"]');
  if (!sel) return;
  const id = Number(sel.closest('tr').dataset.id);
  const { error } = await AGENT.supabase().from('sales_requests').update({ status: sel.value }).eq('id', id);
  if (error) { accMsg(error.message, 'bad'); return; }
  const s = acc.sales.find(x => x.id === id);
  if (s) s.status = sel.value;
  accRender();
});

// ---------- Init ----------
setMode(mode);
// Hosted: wait until signed in and connected to the user's agent.
AGENT.ready.then(() => {
  refreshLicense();
  setInterval(refreshLicense, 6 * 60 * 60 * 1000);   // a plan that ends or is revoked shows up within hours
  showView(store.get('view', 'load'));
  if (uatRunId) openRun(uatRunId);
  loadTargets();
  loadAuthorizations();
  setInterval(loadAuthorizations, 5000);
});
