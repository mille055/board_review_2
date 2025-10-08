import { loadCases } from './store.js';
import { initUI } from './ui.js';
import { bindProgressModal, openProgressModal } from './progress_ui.js';
import { initAuth, logout } from './auth.js';

(async function main(){
  initAuth();                       

  await loadCases();
  initUI();
  bindProgressModal();               // ⬅️ wire up the Progress button

  document.getElementById('logoutBtn')?.addEventListener('click', logout);

  // Optional: auto-open with ?progress=1
  if (new URLSearchParams(location.search).get('progress') === '1') {
    openProgressModal();
  }
})();
