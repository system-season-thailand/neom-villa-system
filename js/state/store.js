/** Minimal observable store for the handful of cross-cutting values every
 * tab/component might care about (connection health, active tab). Each tab
 * component still owns and manages its own local UI state internally —
 * this store is only for state that genuinely needs to be shared. */
export function createStore(initialState) {
  let state = { ...initialState };
  const listeners = new Set();

  return {
    getState() {
      return state;
    },
    setState(patch) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      listeners.forEach((listener) => listener(state));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export const appStore = createStore({
  connection: 'connecting', // 'connecting' | 'online' | 'offline'
  activeTab: 'invoice'
});
