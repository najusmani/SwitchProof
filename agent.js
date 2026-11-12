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

  // Back from an email link (Supabase): a password reset (#...type=recovery), or a link that no longer works
  // (#error=...&error_code=otp_expired...). Read before the sign-in library takes the tokens out of the address.
  const linkParams = new URLSearchParams(location.hash.slice(1) + '&' + location.search.slice(1));
  const emailLink = { recovery: linkParams.get('type') === 'recovery', error: linkParams.get('error_description') || linkParams.get('error') || '', code: linkParams.get('error_code') || '' };

  // The agent opens the site with #agent=...&pair=...; keep them and clear the address bar.
  const hash = new URLSearchParams(location.hash.slice(1));
  const pairedNow = !!hash.get('pair');   // SwitchProof itself just opened this page: it is running on this PC
  if (hash.get('pair')) {
    ls.set('token', hash.get('pair'));
    if (hash.get('agent')) ls.set('url', hash.get('agent'));
    history.replaceState(null, '', location.pathname + location.search);
  }

  // A referral link (?ref=CODE): remembered for 30 days, the first link opened wins. It goes with a new
  // account's sign-up and is claimed once that account is signed in (claim_referral links it only once).
  const REF_RE = /^[A-HJ-NP-Z2-9]{6}$/;
  const REF_DAYS = 30;
  const refStore = {
    get() {
      try {
        const v = JSON.parse(localStorage.getItem('ss.ref') || 'null');
        return v && REF_RE.test(v.code) && Date.now() - v.at < REF_DAYS * 86400e3 ? v.code : null;
      } catch (e) { return null; }
    },
    set(code) { try { localStorage.setItem('ss.ref', JSON.stringify({ code, at: Date.now() })); } catch (e) { /* storage unavailable */ } },
    clear() { try { localStorage.removeItem('ss.ref'); } catch (e) { /* storage unavailable */ } },
  };
  {
    const q = new URLSearchParams(location.search);
    const ref = (q.get('ref') || '').trim().toUpperCase();
    if (q.has('ref')) {
      if (REF_RE.test(ref) && !refStore.get()) refStore.set(ref);
      q.delete('ref');
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    }
  }

  const base = () => (hosted ? (ls.get('url') || cfg.agentUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '') : '');
  const token = () => ls.get('token') || '';

  function url(path) { return base() + path; }

  // ---------- a website reaching a program on the same PC ----------
  // To the browser, this page (public) calling the agent (127.0.0.1) is "local network access". Chrome and Edge
  // ask the user once (permission 'loopback-network'); a browser managed by an organisation can refuse it.
  const loopback = () => /^https?:\/\/(127(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?$/i.test(base());

  // Every request says where it is going (targetAddressSpace), as the browser expects for this kind of call.
  // Browsers that don't know the option ignore it; an older Chrome knows it with other values and would throw,
  // so it is tried once on a Request that is never sent.
  let spaceOption = null;
  function loopbackOption() {
    if (spaceOption === null) {
      try { new Request('http://127.0.0.1/', { targetAddressSpace: 'loopback' }); spaceOption = true; } catch (e) { spaceOption = false; }
    }
    return spaceOption;
  }

  /** fetch() against the agent, with the pairing code when hosted. */
  function apiFetch(path, opts) {
    opts = Object.assign({}, opts || {});
    if (hosted) {
      opts.headers = Object.assign({}, opts.headers || {}, { 'X-Agent-Token': token() });
      if (loopback() && loopbackOption()) opts.targetAddressSpace = 'loopback';
    }
    return fetch(url(path), opts);
  }

  /**
   * What the browser says about this page reaching the agent: 'granted', 'prompt' (it will ask on the first
   * request), 'denied', or 'unknown' when the browser has no such permission to ask about.
   * Only 'loopback-network' is queried: the older name 'local-network-access' crashes some Chrome versions.
   */
  async function reachState() {
    if (!hosted || !loopback() || !navigator.permissions || !navigator.permissions.query) return 'unknown';
    try {
      return (await navigator.permissions.query({ name: 'loopback-network' })).state;
    } catch (e) {
      return 'unknown';
    }
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
  }
  function msg(id, text, kind) { const el = $g(id); el.textContent = text || ''; el.className = 'gate-msg ' + (kind || ''); }

  async function probe() {
    try {
      const res = await apiFetch('/api/agent');
      const d = await res.json();
      if (res.ok && d.agent) return { ok: true, info: d };
      return { ok: false, why: d.error || 'Agent refused the request' };
    } catch (e) {
      return { ok: false, why: 'No agent answering at ' + base() + '. Is SwitchProof running? Open it from the Start menu: its small window should be open.' };
    }
  }

  /** True when version `have` is below `need` (numeric, dot-separated; a missing version counts as oldest). */
  function older(have, need) {
    const p = (v) => String(v || '0').split('.').map(n => parseInt(n, 10) || 0);
    const a = p(have), b = p(need);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
    }
    return false;
  }
  const outdated = (info) => !!cfg.minAgentVersion && info.version !== 'dev' && older(info.version, cfg.minAgentVersion);

  // An outdated agent may not understand this page's requests: block the console until it is updated,
  // and keep checking so the page continues on its own once the new version is running.
  let updateTimer = null;
  function showUpdate(info) {
    show('update');
    $g('guNeed').textContent = cfg.minAgentVersion;
    $g('guHave').textContent = info.version || 'an older version';
    $g('guLatestText').hidden = !cfg.agentVersion;
    $g('guLatest').textContent = cfg.agentVersion || '';
    if (!updateTimer) updateTimer = setInterval(async () => {
      const r = await probe();
      if (r.ok && !outdated(r.info)) connect();
    }, 5000);
  }

  /**
   * The connect screen, with the box that speaks for the browser's permission:
   *   ask      the browser will ask its question on the first request: explain, and let a click start it
   *   blocked  the browser refuses: how to allow it
   *   retry    it worked before on this browser, but SwitchProof isn't answering now
   *   ''       no box (a new user who hasn't installed SwitchProof yet reads the steps below)
   */
  function showConnect(box, why) {
    show('connect');
    $g('gcUrl').value = base();
    $g('gcCode').value = token();
    $g('gcAllow').hidden = !box;
    $g('gcAllow').dataset.state = box;
    $g('gcAsk').hidden = box !== 'ask';
    $g('gcBlocked').hidden = box !== 'blocked';
    $g('gcRetry').hidden = box !== 'retry';
    $g('gcAllowBtn').textContent = box === 'blocked' ? 'Check again' : box === 'retry' ? 'Try again' : 'Connect';
    $g('gcSite').textContent = location.host;
    // Opened by SwitchProof itself: it is installed and running, so the download steps are left out.
    document.querySelector('.gate-step[data-step="connect"]').classList.toggle('paired', pairedNow && !!box);
    msg('gcMsg', why || '', why ? 'bad' : '');
  }

  /** byUser: started by a click. The first request to the agent is never sent without one (see 'ask' above). */
  async function connect(byUser) {
    const reach = await reachState();
    const known = pairedNow || !!token();   // this browser has been paired with a SwitchProof (else: a new user, who reads the steps)
    // Asked out of nowhere, people choose Block. So the first time, this page explains and waits for a click;
    // once the browser has allowed it (or, where the browser can't say, once it has worked) it connects by itself.
    const firstTime = reach === 'prompt' || (reach === 'unknown' && hosted && loopback() && !ls.get('reached'));
    if (!byUser && reach === 'denied') { showConnect('blocked', ''); return false; }
    if (!byUser && firstTime) { showConnect(known ? 'ask' : '', ''); return false; }
    msg('gcMsg', 'Checking ' + base() + ' …');
    const r = await probe();
    if (r.ok && outdated(r.info)) { showUpdate(r.info); return false; }
    if (r.ok) {
      ls.set('reached', '1');
      if (updateTimer) { clearInterval(updateTimer); updateTimer = null; }
      $g('gate').hidden = true;
      document.body.classList.add('agent-ok');
      const who = $g('userEmail');
      if (who && sb) { const { data } = await sb.auth.getUser(); who.textContent = data && data.user ? data.user.email : ''; }
      resolveReady(r.info);
      return true;
    }
    const now = await reachState();   // the answer the user just gave the browser, if it asked
    if (now === 'denied') showConnect('blocked', byUser && reach === 'denied' ? 'Still blocked. Follow the steps above, then press Check again.' : '');
    else if (now === 'prompt') showConnect('ask', 'Not connected. If your browser asked, choose Allow. And is SwitchProof running?');
    else showConnect(known || byUser ? 'retry' : '', r.why);
    return false;
  }

  /** Signed in and came from a referral link: link the account to the referrer (quietly; tried again next time on errors). */
  async function claimReferral() {
    try {
      const { data } = await sb.auth.getUser();
      const user = data && data.user;
      if (!user) return;
      const code = refStore.get() || ((user.user_metadata || {}).ref || '').toUpperCase() || null;
      const done = 'ss.ref.done.' + user.id;
      if (!code || localStorage.getItem(done)) return;
      const { error } = await sb.rpc('claim_referral', { p_code: code });
      if (error) return;   // not set up on the site yet, or offline
      refStore.clear();
      localStorage.setItem(done, '1');
    } catch (e) { /* never in the way of signing in */ }
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
      sb.auth.onAuthStateChange((event) => { if (event === 'PASSWORD_RECOVERY') emailLink.recovery = true; });
    } catch (e) {
      show('login');
      msg('glMsg', 'Could not load the sign-in service. Check your connection and reload.', 'bad');
      return;
    }
    const { data } = await sb.auth.getSession();
    if (emailLink.error || emailLink.recovery) history.replaceState(null, '', location.pathname);   // no tokens or errors left in the address bar
    if (!data.session) {
      show('login');
      if (emailLink.error) {
        msg('glMsg', emailLink.code === 'otp_expired' || /expired|invalid/i.test(emailLink.error)
          ? 'That email link has expired or was already used: each link works once. Enter your email and press Forgot password? for a new one.'
          : "The email link didn't work: " + emailLink.error, 'bad');
      }
      return;
    }
    claimReferral();
    if (emailLink.recovery) { showReset(data.session.user); return; }
    await connect();
  }

  /** Signed in by a password-reset link: choose the new password before anything else. */
  function showReset(user) {
    show('reset');
    $g('grUser').value = (user && user.email) || '';
    msg('grMsg', '');
    setTimeout(() => $g('grPass').focus(), 50);
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
      // A referral code travels with the new account too, so it still counts if the email is confirmed in another browser.
      const ref = refStore.get();
      const fn = signUp
        ? sb.auth.signUp({ email, password, options: Object.assign({ emailRedirectTo: location.origin + location.pathname }, ref ? { data: { ref } } : {}) })
        : sb.auth.signInWithPassword({ email, password });
      const { data, error } = await fn;
      if (error) { msg('glMsg', error.message, 'bad'); return; }
      if (signUp && !data.session) { msg('glMsg', 'Check your email to confirm the account, then sign in.', 'ok'); return; }
      claimReferral();
      await connect();
    });
    $g('glForgot').addEventListener('click', async () => {
      const email = $g('glEmail').value.trim();
      if (!email) { msg('glMsg', 'Enter your email first.', 'bad'); return; }
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      msg('glMsg', error ? error.message : 'Check your email for a link to choose a new password. Use the newest email: each link works once.', error ? 'bad' : 'ok');
    });
    $g('grForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if ($g('grPass').value !== $g('grPass2').value) { msg('grMsg', "The two passwords don't match.", 'bad'); return; }
      msg('grMsg', 'Saving…');
      const { error } = await sb.auth.updateUser({ password: $g('grPass').value });
      if (error) { msg('grMsg', error.message, 'bad'); return; }
      emailLink.recovery = false;
      msg('grMsg', 'Password changed.', 'ok');
      await connect();
    });

    async function download(msgId) {
      msg(msgId, 'Preparing download…');
      const r = await downloadInstaller();
      msg(msgId, r.error || '', r.error ? 'bad' : '');
    }
    if (cfg.agentVersion && $g('acctNewVer')) $g('acctNewVer').textContent = cfg.agentVersion;
    if (cfg.agentVersion) {   // the version in the download
      for (const [btn, note] of [['gcDownload', 'gcVer'], ['guDownload', 'guVer']]) {
        $g(btn).textContent = 'Download SwitchProof ' + cfg.agentVersion;
        $g(note).textContent = (cfg.downloadPath || 'SwitchProof-Setup.exe') + ' · version ' + cfg.agentVersion + ' · Windows 10 or 11';
        $g(note).hidden = false;
      }
    }
    $g('gcDownload').addEventListener('click', () => download('gcDlMsg'));
    $g('guDownload').addEventListener('click', () => download('guDlMsg'));
    $g('guRetry').addEventListener('click', async () => {
      msg('guMsg', 'Checking…');
      const r = await probe();
      if (!r.ok) { msg('guMsg', 'SwitchProof is not running. Open it from the Start menu.', 'bad'); return; }
      if (outdated(r.info)) { msg('guMsg', 'Still version ' + (r.info.version || 'unknown') + '. Run the new installer: it closes SwitchProof, updates it and starts it again.', 'bad'); return; }
      msg('guMsg', '');
      connect();
    });
    $g('gcForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      ls.set('url', $g('gcUrl').value.trim() || null);
      ls.set('token', $g('gcCode').value.trim() || null);
      await connect(true);
    });
    $g('gcAllowBtn').addEventListener('click', () => connect(true));
    document.querySelectorAll('[data-signout]').forEach(b => b.addEventListener('click', async () => {
      try { await apiFetch('/api/license', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: null }) }); } catch (e) { /* agent not reachable */ }
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

  /** The signed-in Supabase client (hosted mode only; null before sign-in or when running locally). */
  const supabase = () => sb;

  /** Starts the installer download (signed link to the private bucket). */
  async function downloadInstaller() {
    if (!sb) return { error: 'Sign in first' };
    const { data, error } = await sb.storage.from(cfg.downloadBucket || 'downloads').createSignedUrl(cfg.downloadPath || 'switchproof-agent.jar', 120, { download: true });
    if (error) return { error: error.message };
    location.href = data.signedUrl;
    return {};
  }
  /** The version in the download, when it is newer than the SwitchProof on this PC. */
  const updateFor = (have) => (hosted && cfg.agentVersion && have && older(have, cfg.agentVersion) ? cfg.agentVersion : null);

  return { hosted, url, link, apiFetch, ready, base, supabase, downloadInstaller, updateFor };
})();

const apiFetch = AGENT.apiFetch;
