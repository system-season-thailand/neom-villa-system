// App entry point: wires up tab navigation, the connection indicator, the
// service worker, and mounts each tab's component once at startup (tabs are
// kept in the DOM and simply shown/hidden, so in-progress form state is
// never lost when staff switch between them).
const TABS = ['invoice', 'prices', 'availability'];

function initTabs() {
  const buttons = Array.from(document.querySelectorAll('.tab-btn'));
  const panels = {
    invoice: document.getElementById('tab-invoice'),
    prices: document.getElementById('tab-prices'),
    availability: document.getElementById('tab-availability')
  };

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab, buttons, panels));
  });
}

function switchTab(tab, buttons, panels) {
  if (!TABS.includes(tab)) return;
  buttons.forEach((btn) => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  Object.entries(panels).forEach(([key, panel]) => {
    panel.hidden = key !== tab;
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

function showFatalError(message) {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div class="state-block" style="height:100vh; justify-content:center;">
      <div class="state-icon">⚠</div>
      <div class="state-title">Neom Villa console failed to start</div>
      <div class="state-desc">${message}</div>
      <button class="btn btn-primary" style="margin-top:12px;" onclick="location.reload()">Reload</button>
    </div>
  `;
}

async function initConnectionStatus(pingSupabase) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');

  async function check() {
    dot.className = 'status-dot is-pending';
    label.textContent = 'Connecting…';
    try {
      await pingSupabase();
      dot.className = 'status-dot is-online';
      label.textContent = 'Online';
    } catch {
      dot.className = 'status-dot is-offline';
      label.textContent = 'Offline';
    }
  }

  check();
  window.addEventListener('online', check);
  window.addEventListener('offline', () => {
    dot.className = 'status-dot is-offline';
    label.textContent = 'Offline';
  });
  setInterval(check, 60000);
}

async function init() {
  initTabs();
  registerServiceWorker();

  // Dynamic imports so a CDN hiccup (Supabase/jsPDF failing to load) shows a
  // clear, recoverable error screen instead of a blank white page.
  let supabaseConfig, invoiceTab, pricesTab, availabilityTab;
  try {
    [supabaseConfig, invoiceTab, pricesTab, availabilityTab] = await Promise.all([
      import('./config/supabase.js'),
      import('./components/invoiceTab.js'),
      import('./components/pricesTab.js'),
      import('./components/availabilityTab.js')
    ]);
  } catch (err) {
    console.error(err);
    showFatalError(
      'Could not load required app modules. Check your internet connection (a one-time load is needed the first time you open the app) and reload.'
    );
    return;
  }

  initConnectionStatus(supabaseConfig.pingSupabase);

  try {
    invoiceTab.mount(document.getElementById('tab-invoice'));
    pricesTab.mount(document.getElementById('tab-prices'));
    availabilityTab.mount(document.getElementById('tab-availability'));
  } catch (err) {
    console.error(err);
    showFatalError('An unexpected error occurred while starting the app. Please reload.');
  }
}

document.addEventListener('DOMContentLoaded', init);
