import { loadCases } from './store.js';
import { initUI } from './ui.js';
import { bindProgressModal, openProgressModal } from './progress_ui.js';

(async function main(){
  await loadCases();
  initUI();
  bindProgressModal();               // ⬅️ wire up the Progress button

  // Optional: auto-open with ?progress=1
  if (new URLSearchParams(location.search).get('progress') === '1') {
    openProgressModal();
  }
})();
