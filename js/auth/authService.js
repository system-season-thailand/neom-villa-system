// A lightweight "which staff member is this" gate — NOT a real security
// boundary. The passwords below live in this client-side bundle, visible to
// anyone who opens dev tools or views source, and every Supabase table this
// app talks to still has an RLS policy fully open to the anon key regardless
// of what's entered here (see DATABASE.md). This exists purely to keep the
// two staff-facing tabs out of the way for non-admin users sharing one
// device — not to protect the underlying data. If this app's URL is ever
// exposed beyond trusted staff, that needs real Supabase Auth, not this.
const STORAGE_KEY = 'neom_villa_role';
const ROLES = ['admin', 'user'];

const CREDENTIALS = {
  '00Admin00': 'admin',
  '00Season00': 'user'
};

/** Returns the signed-in role ('admin' | 'user'), or null if not signed in. */
export function getRole() {
  const role = localStorage.getItem(STORAGE_KEY);
  return ROLES.includes(role) ? role : null;
}

/** Checks a password, stores the resulting role in localStorage, and returns it — or null if it didn't match either password. */
export function login(password) {
  const role = CREDENTIALS[password];
  if (!role) return null;
  localStorage.setItem(STORAGE_KEY, role);
  return role;
}

export function logout() {
  localStorage.removeItem(STORAGE_KEY);
}
