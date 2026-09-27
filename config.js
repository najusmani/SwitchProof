// Hosted build: sign-in via Supabase, then everything goes to the user's own agent.
window.SWITCHPROOF_CONFIG = {
  mode: 'hosted',
  productName: 'SwitchProof',
  supabaseUrl: 'https://ekkftykqwrzkheaqqwne.supabase.co',
  supabaseAnonKey: 'sb_publishable_1-0edWNZ0Yf2WL5wzr8Iyw_PZD7l3Gn',   // public by design; access is enforced by Supabase policies
  downloadBucket: 'downloads',
  downloadPath: 'SwitchProof-Setup.exe',
  minAgentVersion: '1.4.2',   // older installed agents must update before using the site
  agentVersion: '1.4.2',   // the version in the download (shown on the download and update screens)
  agentUrl: 'http://127.0.0.1:8787',
  paddle: { token: 'live_cb9f416cb8e5df542ccb86bc39a', environment: 'production', prices: { team: 'pri_01m3hjh3d36jsqb490naa1f0f7', enterprise: 'pri_01m3hjkh0mgngjz5nbb9h98gep' }, discount: { code: 'TRIAL50', text: '50% off every month' } },   // card checkout; the plan is granted by the paddle-webhook function, never by the browser
};