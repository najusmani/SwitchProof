'use strict';

/*
 * Where the console's /api lives, and the gates in front of it when the UI is hosted.
 *
 * Local mode (page served by the agent itself): same-origin calls, no login, no pairing.
 * Hosted mode (page on a public website, config.js sets mode: 'hosted'):
 *   1. Sign in (Supabase auth)          -> 2. Download the agent (private, signed link)
 *   3. Agent runs on the user's PC, inside their network, and opens this page with
 *      #agent=<url>&pair=<code>; every call then goes to that agent with the pairing code.
 * The switch is only ever reached by the agent, so bank IPs, accounts and evidence stay on
 * the user's machine.
 */
const AGENT = (() => {
  const cfg = Object.assign({ mode: 'local' }, window.SWITCHPROOF_CONFIG || {});
  const hosted = cfg.mode === 'hosted';
  const ls = {
    get(k) { try { return localStorage.getItem('ss.agent.' + k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('ss.agent.' + k) : localStorage.setItem('ss.agent.' + k, v); } catch (e) { /* storage unavailable */ } },
  };

  // The agent opens the site with #agent=...&pair=...; keep them and clear the address bar.
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('pair')) {
    ls.set('token', hash.get('pair'));
    if (hash.get('agent')) ls.set('url', hash.get('agent'));
    history.replaceState(null, '', location.pathname + location.search);
  }

  const base = () => (hosted ? (ls.get('url') || cfg.agentUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '') : '');
  const token = () => ls.get('token') || '';

  function url(path) { return base() + path; }

  /** fetch() against the agent, with the pairing code when hosted. */
  function apiFetch(path, opts) {
    opts = Object.assign({}, opts || {});
    if (hosted) opts.headers = Object.assign({}, opts.headers || {}, { 'X-Agent-Token': token() });
    return fetch(url(path), opts);
  }

  /** href for links opened in a new tab (reports, CSV) -- those can't carry a header. */
  function link(path) {
    if (!hosted) return path;
    return url(path) + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token());
  }

  // ---------- gates (hosted only) ----------
  let sb = null;
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });
  const $g = (id) => document.getElementById(id);

  function show(step) {
    $g('gate').hidden = false;
    document.querySelectorAll('.gate-step').forEach(el => { el.hidden = el.dataset.step !== step; });
    const intro = $g('gateIntro');
    if (intro) intro.hidden = step !== 'login';
    $g('gate').classList.toggle('with-intro', step === 'login');
  }
  function msg(id, text, kind) { const el = $g(id); el.textContent = text || ''; el.className = 'gate-msg ' + (kind || ''); }

  async function probe() {
    try {
      const res = await apiFetch('/api/agent');
      const d = await res.json();
      if (res.ok && d.agent) return { ok: true, info: d };
      return { ok: false, why: d.error || 'Agent refused the request' };
    } catch (e) {
      return { ok: false, why: 'No agent answering at ' + base() + '. Is SwitchProof running (open it from the Start menu; its small window should be open)? If the browser asked about local network access, allow it and press Connect.' };
    }
  }

  async function connect() {
    msg('gcMsg', 'Checking ' + base() + ' …');
    const r = await probe();
    if (r.ok) {
      $g('gate').hidden = true;
      document.body.classList.add('agent-ok');
      const who = $g('userEmail');
      if (who && sb) { const { data } = await sb.auth.getUser(); who.textContent = data && data.user ? data.user.email : ''; }
      resolveReady(r.info);
      return true;
    }
    show('connect');
    $g('gcUrl').value = base();
    $g('gcCode').value = token();
    msg('gcMsg', r.why, 'bad');
    return false;
  }

  function loadScript(src) {
    return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
  }

  async function startHosted() {
    document.body.classList.add('hosted');
    if (cfg.productName) document.querySelectorAll('.brand-name').forEach(el => { el.textContent = cfg.productName; });
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/dist/umd/supabase.min.js');
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    } catch (e) {
      show('login');
      msg('glMsg', 'Could not load the sign-in service. Check your connection and reload.', 'bad');
      return;
    }
    const { data } = await sb.auth.getSession();
    if (!data.session) { show('login'); return; }
    await connect();
  }

  function wireGate() {
    let signUp = false;
    $g('glToggle').addEventListener('click', () => {
      signUp = !signUp;
      $g('glTitle').textContent = signUp ? 'Create your account' : 'Sign in';
      $g('glSubmit').textContent = signUp ? 'Create account' : 'Sign in';
      $g('glToggle').textContent = signUp ? 'I already have an account' : 'Create an account';
      msg('glMsg', '');
    });
    $g('glForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $g('glEmail').value.trim(), password = $g('glPass').value;
      msg('glMsg', signUp ? 'Creating account…' : 'Signing in…');
      // Confirmation emails return to this exact page (must be listed under Supabase > Auth > Redirect URLs).
      const fn = signUp
        ? sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
        : sb.auth.signInWithPassword({ email, password });
      const { data, error } = await fn;
      if (error) { msg('glMsg', error.message, 'bad'); return; }
      if (signUp && !data.session) { msg('glMsg', 'Check your email to confirm the account, then sign in.', 'ok'); return; }
      await connect();
    });
    $g('glForgot').addEventListener('click', async () => {
      const email = $g('glEmail').value.trim();
      if (!email) { msg('glMsg', 'Enter your email first.', 'bad'); return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      msg('glMsg', error ? error.message : 'Password reset email sent.', error ? 'bad' : 'ok');
    });

    $g('gcDownload').addEventListener('click', async () => {
      msg('gcDlMsg', 'Preparing download…');
      const { data, error } = await sb.storage.from(cfg.downloadBucket || 'downloads').createSignedUrl(cfg.downloadPath || 'switchproof-agent.jar', 120, { download: true });
      if (error) { msg('gcDlMsg', error.message, 'bad'); return; }
      msg('gcDlMsg', '');
      location.href = data.signedUrl;
    });
    $g('gcForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      ls.set('url', $g('gcUrl').value.trim() || null);
      ls.set('token', $g('gcCode').value.trim() || null);
      await connect();
    });
    document.querySelectorAll('[data-signout]').forEach(b => b.addEventListener('click', async () => {
      if (sb) await sb.auth.signOut();
      location.reload();
    }));
    const disc = $g('agentDisconnect');
    if (disc) disc.addEventListener('click', () => { ls.set('token', null); location.reload(); });
  }

  if (hosted) {
    document.addEventListener('DOMContentLoaded', () => { wireGate(); startHosted(); });
  } else {
    resolveReady(null);
  }

  return { hosted, url, link, apiFetch, ready, base };
})();

const apiFetch = AGENT.apiFetch;
