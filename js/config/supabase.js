// Supabase project configuration.
//
// Per the project brief this app is staff-only and hardcodes its credentials
// instead of relying on a build step / environment variables (there is no
// bundler — this is a plain static site deployed to GitHub Pages). The anon
// key is safe to ship client-side by design: every table it can reach is
// protected by the Row Level Security policies defined in /sql.
//
// There is no Storage bucket — generated PDFs are never uploaded anywhere.
// Each invoice revision stores its full data snapshot in `neom_pdf.invoice_data`
// and the PDF is regenerated on demand from that snapshot (see pdfGenerator.js).
const SUPABASE_URL = 'https://lyerdfajywajzgflvovo.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5ZXJkZmFqeXdhanpnZmx2b3ZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ1NjQxMzgsImV4cCI6MjEwMDE0MDEzOH0.3fYioCCQVh7IDkYpO-C_AD_Kx9uz5zu_k-F7xfyKsy4';

if (!window.supabase || typeof window.supabase.createClient !== 'function') {
  throw new Error(
    'Supabase client library failed to load. Check your internet connection and reload the page.'
  );
}

export const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

/**
 * Lightweight reachability probe used by the topbar connection indicator.
 * Selects a single row's count from the lightest table so it stays cheap.
 */
export async function pingSupabase() {
  const { error } = await supabaseClient
    .from('neom_price')
    .select('id', { count: 'exact', head: true });
  if (error) throw error;
  return true;
}
