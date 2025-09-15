import { SUBS, CONFIG } from './config.js';
import { getAll, setCases } from './store.js';
import { openViewer as openViewerBase } from './viewer.js';
import { toggleMic, pasteTranscript, getTranscript } from './speech.js';
import { gradeHeuristic, heuristicFeedback, buildLLMPayload, letter } from './grade.js';
import { recordAttempt, getStats } from './progress.js';

const chips = document.getElementById('chips');
const grid = document.getElementById('grid');
const countEl = document.getElementById('count');

const vFeedback = document.getElementById('vFeedback');
const vScore = document.getElementById('vScore');
const vLLM = document.getElementById('vLLM');

/* ---------- Local filter state ---------- */
let activeSubs = new Set();
let queryStr = "";

/* ---------- Helpers ---------- */
function haystack(c){
  return [
    c.title || "",
    c.boardPrompt || "",
    c.expectedAnswer || "",
    (c.tags || []).join(" "),
    c.subspecialty || ""
  ].join(" ").toLowerCase();
}

function getFiltered(){
  const all = getAll();
  return all.filter(c=>{
    const okSub = activeSubs.size ? activeSubs.has(c.subspecialty) : true;
    const okQ   = queryStr ? haystack(c).includes(queryStr) : true;
    return okSub && okQ;
  });
}

function randomPick(list){
  if(!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function updateCounts(){
  const total = getAll().length;
  const { reviewedCount } = getStats(total);
  const list = getFiltered();
  countEl.textContent = `${list.length} case${list.length===1?'':'s'} • Reviewed ${reviewedCount}/${total}`;
}

/* ---------- Public init ---------- */
export function initUI(){
  // Build chips
  const chipEls=[];
  SUBS.forEach(s=>{
    const c = document.createElement('div');
    c.className='chip'; c.textContent=s;
    c.onclick=()=>{
      c.classList.toggle('active');
      if(c.classList.contains('active')) activeSubs.add(s); else activeSubs.delete(s);
      render();
    };
    chips.appendChild(c);
    chipEls.push({el:c, name:s});
  });

  // All / None
  document.getElementById('subsAll').onclick = ()=>{
    activeSubs = new Set(SUBS);
    chipEls.forEach(x=>x.el.classList.add('active'));
    render();
  };
  document.getElementById('subsNone').onclick = ()=>{
    activeSubs.clear();
    chipEls.forEach(x=>x.el.classList.remove('active'));
    render();
  };

  // Search
  document.getElementById('q').addEventListener('input', e=>{
    queryStr = (e.target.value || '').trim().toLowerCase();
    render();
  });
  document.getElementById('clear').onclick=()=>{
    document.getElementById('q').value='';
    queryStr='';
    render();
  };

  // Randoms
  document.getElementById('randomOne').onclick=()=>{
    const c = randomPick(getFiltered());
    if(!c) return alert('No cases loaded. Use "Load Samples" or "Import JSON".');
    window.openViewer(c);
  };
  document.getElementById('randomSet').onclick=()=>{
    const list = getFiltered();
    if(!list.length) return alert('No cases loaded. Use "Load Samples" or "Import JSON".');
    const n = Math.min(5, list.length);
    alert("Random set:\n\n" + shuffle([...list]).slice(0,n).map(c=>`• ${c.title} — ${c.subspecialty}`).join('\n'));
  };

  // Import / Load samples
  document.getElementById('importBtn').onclick=()=>document.getElementById('fileInput').click();
  document.getElementById('fileInput').addEventListener('change', async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    try{
      const json = JSON.parse(await file.text());
      if(Array.isArray(json)){ setCases(json); render(); alert(`Imported ${json.length} cases ✔`); }
      else { alert('JSON must be an array of cases'); }
    }catch{ alert('Invalid JSON'); }
  });

  document.getElementById('loadSamples').onclick = ()=>{
    fetch('data/cases.json', {cache:'no-store'})
      .then(r=>r.json())
      .then(arr=>{ setCases(arr); render(); alert(`Loaded ${arr.length} sample cases ✔`); });
  };

  // Viewer actions
  document.getElementById('vMicBtn').onclick = toggleMic;
  document.getElementById('vPasteBtn').onclick = pasteTranscript;

  // 🚀 Make this handler async to allow 'await' inside
  document.getElementById('gradeBtn').onclick = async ()=>{
    const tr = getTranscript();
    if(!tr) return alert('No transcript. Use mic or paste text.');
    const caseObj = window.__currentCaseForGrading; // set when opening viewer
    if(!caseObj) return;

    const heur = gradeHeuristic({
      transcript: tr,
      promptTxt: caseObj.boardPrompt || '',
      expected:  caseObj.expectedAnswer || '',
      rubric:    caseObj.rubric || []
    });

    vFeedback.textContent = heuristicFeedback(heur);
    vScore.textContent = `${Math.round(heur.similarity*100)}% • ${heur.rubricHit}/${(caseObj.rubric||[]).length} • ${letter(heur)}`;

    const payload = buildLLMPayload({caseObj, transcript:tr, heur});
    vLLM.textContent = JSON.stringify(payload, null, 2);

    // Optional LLM call (skipped unless you wire a backend)
    if (CONFIG?.FEEDBACK_MODE && CONFIG.FEEDBACK_MODE !== 'heuristic') {
      try {
        // Only call if gradeWithLLM exists in your grade.js
        const mod = await import('./grade.js');
        if (typeof mod.gradeWithLLM === 'function' && CONFIG.FEEDBACK_MODE !== 'heuristic') {
          const llm = await mod.gradeWithLLM({caseObj, transcript: tr, heur});
          if (llm?.feedback) {
            vFeedback.textContent += (vFeedback.textContent ? '\n\n— LLM feedback —\n' : '') + llm.feedback;
          }
        }
      } catch (e) {
        console.error('[UI] LLM call failed', e);
        vFeedback.textContent += `\n\n— LLM error —\n${e.message || e}`;
      }
    }

    // Progress tracking
    recordAttempt({
      caseId: caseObj.id,
      subspecialty: caseObj.subspecialty || 'Unknown',
      similarity: heur.similarity,
      rubricHit: heur.rubricHit,
      rubricTotal: (caseObj.rubric || []).length,
      letter: letter(heur)
    });
    updateCounts();
  };

  // Bridge to viewer (viewer handles clearing transcript/feedback on open)
  window.openViewer = (c)=>{ window.__currentCaseForGrading = c; openViewerBase(c); };

  render(); // initial
}

/* ---------- Render grid ---------- */
function render(){
  updateCounts();

  const list = getFiltered();
  grid.innerHTML = list.length ? '' : `<div class="small">No cases match your filters. Load samples or import your JSON.</div>`;

  list.forEach(c=>{
    const card = document.createElement('div'); card.className='card';

    const th = document.createElement('div'); th.className='thumb';
    const img = document.createElement('img'); img.loading='lazy'; img.src = c.images?.[0] || ''; th.appendChild(img);

    const title = document.createElement('div'); title.textContent = c.title;

    const meta = document.createElement('div'); meta.className='meta';
    const sub = document.createElement('span'); sub.className='pill'; sub.textContent = c.subspecialty;

    const actions = document.createElement('div'); actions.style.display='flex'; actions.style.gap='8px';
    const choose = document.createElement('button'); choose.className='btn ghost'; choose.textContent='Choose';
    choose.onclick=()=>window.openViewer(c);
    const random = document.createElement('button'); random.className='btn'; random.textContent='Random similar';
    random.onclick=()=> {
      const pool = getAll().filter(x=>x.subspecialty===c.subspecialty);
      window.openViewer(randomPick(pool) || c);
    };

    actions.appendChild(choose); actions.appendChild(random);
    meta.appendChild(sub); meta.appendChild(actions);

    card.appendChild(th);
    card.appendChild(title);
    card.appendChild(meta);
    grid.appendChild(card);
  });
}

/* ---------- Utils ---------- */
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
