// App entry point: gates the whole app behind a staff password (see
// js/auth/authService.js — this is a UX convenience, not real security),
// then wires up tab navigation and the connection indicator, and mounts
// each tab's component once at startup (tabs are kept in the DOM and simply
// shown/hidden, so in-progress form state is never lost when staff switch
// between them).
import { getRole, logout } from './auth/authService.js';

const TABS = ['invoice', 'prices', 'availability'];
const ROLE_LABELS = { admin: 'Admin', user: 'User' };

function initTabs(role) {
  const buttons = Array.from(document.querySelectorAll('.tab-btn'));
  const panels = {
    invoice: document.getElementById('tab-invoice'),
    prices: document.getElementById('tab-prices'),
    availability: document.getElementById('tab-availability')
  };

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab, buttons, panels));
  });

  // The "user" role only ever sees the Availability tab — فاتورة and اسعار
  // deal in pricing and guest invoices, which is admin-only territory.
  if (role === 'user') {
    buttons.forEach((btn) => {
      if (btn.dataset.tab !== 'availability') btn.hidden = true;
    });
    switchTab('availability', buttons, panels);
  }
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

function initRoleUI(role) {
  const badge = document.getElementById('role-badge');
  if (badge) badge.textContent = ROLE_LABELS[role] || role;

  const logoutBtn = document.getElementById('btn-logout');
  logoutBtn?.addEventListener('click', () => {
    logout();
    location.reload();
  });
}

// The app previously registered a cache-first service worker for offline
// app-shell caching. It was removed — a cache-first strategy means every
// edit to a cached file needs a manual cache-version bump to reach already-
// installed clients, and a normal reload (vs. a hard reload) kept serving
// stale files in the meantime, which was more friction than the offline
// support was worth for a staff tool that's always used online. This
// actively unregisters any service worker a client installed before that
// change, so nobody stays stuck on stale cached files going forward.
function unregisterServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => reg.unregister());
  });
  if ('caches' in window) {
    caches.keys().then((keys) => keys.forEach((key) => caches.delete(key)));
  }
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
  const role = getRole();
  if (!role) {
    const { renderLoginGate } = await import('./components/loginGate.js');
    renderLoginGate();
    return;
  }

  initTabs(role);
  initRoleUI(role);
  unregisterServiceWorker();

  // Dynamic imports so a CDN hiccup (Supabase/jsPDF failing to load) shows a
  // clear, recoverable error screen instead of a blank white page. The
  // "user" role never even downloads invoiceTab.js/pricesTab.js — it can't
  // reach either tab, so there's no reason to fetch or mount them.
  let supabaseConfig, availabilityTab, invoiceTab, pricesTab;
  try {
    const modules = await Promise.all([
      import('./config/supabase.js'),
      import('./components/availabilityTab.js'),
      ...(role === 'admin' ? [import('./components/invoiceTab.js'), import('./components/pricesTab.js')] : [])
    ]);
    [supabaseConfig, availabilityTab, invoiceTab, pricesTab] = modules;
  } catch (err) {
    console.error(err);
    showFatalError(
      'Could not load required app modules. Check your internet connection (a one-time load is needed the first time you open the app) and reload.'
    );
    return;
  }

  initConnectionStatus(supabaseConfig.pingSupabase);

  try {
    availabilityTab.mount(document.getElementById('tab-availability'), { readOnly: role === 'user' });
    if (role === 'admin') {
      invoiceTab.mount(document.getElementById('tab-invoice'));
      pricesTab.mount(document.getElementById('tab-prices'));
    }
  } catch (err) {
    console.error(err);
    showFatalError('An unexpected error occurred while starting the app. Please reload.');
  }
}

document.addEventListener('DOMContentLoaded', init);
