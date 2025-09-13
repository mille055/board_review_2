import { loadCases } from './store.js';
import { initUI } from './ui.js';

(async function main(){
  // Initial render with empty list; user can click "Load Samples" or Import JSON
  await loadCases(); // tries data/cases.json; ok if missing
  initUI();
})();
