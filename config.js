// Hosted build: sign-in via Supabase, then everything goes to the user's own agent.
window.SWITCHPROOF_CONFIG = {
  mode: 'hosted',
  productName: 'SwitchProof',
  supabaseUrl: 'https://ekkftykqwrzkheaqqwne.supabase.co',
  supabaseAnonKey: 'sb_publishable_1-0edWNZ0Yf2WL5wzr8Iyw_PZD7l3Gn',   // public by design; access is enforced by Supabase policies
  downloadBucket: 'downloads',
  downloadPath: 'SwitchProof-Setup.exe',
  minAgentVersion: '1.3.0',   // older installed agents must update before using the site
  agentUrl: 'http://127.0.0.1:8787',
};