import { SUBS, CONFIG } from './config.js';
import { getAll, setCases } from './store.js';
import { openViewer as openViewerBase } from './viewer.js';
import { toggleMic, getTranscript } from './speech.js';
//import { pasteTranscript } from './speech.js';
import { gradeHeuristic, heuristicFeedback, buildLLMPayload, letter } from './grade.js';
import { recordAttempt, getStats } from './progress.js';

const chips   = document.getElementById('chips');
const grid    = document.getElementById('grid');
const countEl = document.getElementById('count');

const vFeedback = document.getElementById('vFeedback');
const vScore    = document.getElementById('vScore');
const vLLM      = document.getElementById('vLLM');

// ===== Mode (oral | mcq) =====
let mode = (localStorage.getItem('mode') || 'oral'); // 'oral' default

/* ---------- Local filter state ---------- */
let activeSubs = new Set();
let queryStr   = "";

/* ---------- Helpers ---------- */
function setToggleChecked(on){
  const a = document.getElementById('modeToggle');
  if (a) a.checked = !!on;
}

// Pick a thumbnail: prefer media image/poster, else first images[] item
function getThumbSrc(c){
  if (Array.isArray(c.media) && c.media.length){
    for (const m of c.media){
      if (m.type === 'image' && m.src) return m.src;
      if (m.poster) return m.poster;
    }
  }
  return (c.images && c.images[0]) || '';
}

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

/* ---------- Mode UI ---------- */
function renderMode(){
  const oralPane = document.getElementById('oralPane');
  const mcqPane  = document.getElementById('mcqPane');
  if (oralPane) oralPane.style.display = (mode === 'oral') ? 'block' : 'none';
  if (mcqPane)  mcqPane.style.display  = (mode === 'mcq')  ? 'block' : 'none';
}

function bindModeToggle(){
  const el = document.getElementById('modeToggle');
  if (!el) return;
  el.checked = (mode === 'mcq');
  const onFlip = (checked)=>{
    mode = checked ? 'mcq' : 'oral';
    localStorage.setItem('mode', mode);
    setToggleChecked(mode === 'mcq');
    renderMode();
    const c = window.__currentCaseForGrading;
    if (!c) return;
    if (mode === 'mcq') renderMCQs(c); else clearMCQs();
  };
  el.addEventListener('input',  (e)=> onFlip(e.target.checked));
  el.addEventListener('change', (e)=> onFlip(e.target.checked));
}

/* ---------- Render markdown helpers (safe) ---------- */
function renderMarkdown(md) {
  if (window.marked && window.DOMPurify) {
    return DOMPurify.sanitize(marked.parse(String(md || '')));
  }
  const esc = String(md || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/\n/g, '<br>');
}
function escapeWithBr(s){
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/\n/g,'<br>');
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

  // Viewer actions (oral mode widgets live in oralPane)
  document.getElementById('vMicBtn')?.addEventListener('click', toggleMic);
  //document.getElementById('vPasteBtn')?.addEventListener('click', pasteTranscript);

  // 🚀 Make this handler async to allow 'await' inside
  // document.getElementById('gradeBtn')?.addEventListener('click', async ()=>{
  //   const tr = getTranscript();
  //   if(!tr) return alert('No transcript. Use mic or paste text.');
  //   const caseObj = window.__currentCaseForGrading; // set when opening viewer
  //   if(!caseObj) return;
  document.getElementById('gradeBtn')?.addEventListener('click', async ()=>{
    const transcriptEl = document.getElementById('vTranscript'); // Get element directly
    const tr = transcriptEl ? transcriptEl.value.trim() : ''; // Read .value
  
    console.log('Transcript element:', transcriptEl); // Debug line
    console.log('Transcript value:', tr); // Debug line
  
    if(!tr) return alert('No transcript. Use mic or type your response.');
  
    const caseObj = window.__currentCaseForGrading;
    if(!caseObj) return;

    const heur = gradeHeuristic({
      transcript: tr,
      promptTxt: caseObj.boardPrompt || '',
      expected:  caseObj.expectedAnswer || '',
      rubric:    caseObj.rubric || []
    });

    if (vFeedback) vFeedback.textContent = heuristicFeedback(heur);
    if (vScore)    vScore.textContent = `${Math.round(heur.similarity*100)}% • ${heur.rubricHit}/${(caseObj.rubric||[]).length} • ${letter(heur)}`;

    const payload = buildLLMPayload({caseObj, transcript:tr, heur});
    if (vLLM) vLLM.textContent = JSON.stringify(payload, null, 2);

    // Optional LLM call (skipped unless you wire a backend)
    if (CONFIG?.FEEDBACK_MODE && CONFIG.FEEDBACK_MODE !== 'heuristic') {
      try {
        const mod = await import('./grade.js');
        if (typeof mod.gradeWithLLM === 'function' && CONFIG.FEEDBACK_MODE !== 'heuristic') {
          const llm = await mod.gradeWithLLM({caseObj, transcript: tr, heur});
          if (llm?.feedback && vFeedback) {
            vFeedback.textContent += (vFeedback.textContent ? '\n\n— LLM feedback —\n' : '') + llm.feedback;
          }
        }
      } catch (e) {
        console.error('[UI] LLM call failed', e);
        if (vFeedback) vFeedback.textContent += `\n\n— LLM error —\n${e.message || e}`;
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
  });

  // Bridge to viewer (and MCQ renderer)
  window.openViewer = (c)=>{
    window.__currentCaseForGrading = c;
    openViewerBase(c);

    // if user left the app in MCQ mode but this case has no MCQs, fall back to oral
    if (mode === 'mcq' && !(c?.mcqs?.questions?.length)) {
      mode = 'oral';
      localStorage.setItem('mode', mode);
    }

    // reflect mode in UI + render content
    setToggleChecked(mode === 'mcq');
    renderMode();
    if (mode === 'mcq') renderMCQs(c); else clearMCQs();
  };

  // LLM chat in-viewer
  bindLLMChatUI();
  document.getElementById('llmAskBtnOral')?.addEventListener('click', ()=>{
    const c = window.__currentCaseForGrading;
    if (!c) return alert('Open a case first.');
    openLLMChat(c, 'oral');
  });

  bindModeToggle();
  renderMode();
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
    const img = document.createElement('img'); img.loading='lazy'; img.src = getThumbSrc(c) || ''; th.appendChild(img);

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

/* ---------- MCQ rendering & grading ---------- */
function clearMCQs(){
  const pane = document.getElementById('mcqPane');
  if (pane) pane.innerHTML = '';
}

function renderMCQs(caseObj){
  const pane = document.getElementById('mcqPane');
  if (!pane) return; // optional container
  pane.innerHTML = '';

  const spec = caseObj.mcqs;
  if (!spec || !spec.questions || !spec.questions.length){
    pane.innerHTML = '<div class="small muted">No multiple-choice questions for this case.</div>';
    return;
  }

  const qs = spec.shuffle_questions ? [...spec.questions].sort(()=>Math.random()-0.5) : spec.questions;

  const form = document.createElement('form');
  form.id = 'mcqForm';
  form.className = 'mcq-form';

  qs.forEach((q, idx)=>{
    const isMulti = q.multi_select || (q.choices.filter(c=>c.correct).length > 1);
    const group = `q_${q.id || idx}`;

    const card = document.createElement('div');
    card.className = 'mcq-card';

    const stem = document.createElement('div');
    stem.className = 'mcq-stem';
    stem.textContent = `${idx+1}. ${q.stem}`;
    card.appendChild(stem);

    const choices = q.shuffle_choices ? [...q.choices].sort(()=>Math.random()-0.5) : q.choices;
    choices.forEach(ch=>{
      const id = `${group}_${ch.id}`;
      const label = document.createElement('label');
      label.className = 'mcq-choice';

      const inp = document.createElement('input');
      inp.type = isMulti ? 'checkbox' : 'radio';
      inp.name = group;
      inp.value = ch.id;
      inp.id = id;

      const txt = document.createElement('span'); txt.textContent = ch.text;
      label.appendChild(inp); label.appendChild(txt);
      card.appendChild(label);
    });

    const expl = document.createElement('div');
    expl.className = 'mcq-explain hidden';
    card.appendChild(expl);

    form.appendChild(card);
  });

  const actions = document.createElement('div');
  actions.className = 'mcq-actions';
  const btn = document.createElement('button'); btn.type = 'submit'; btn.textContent = 'Check answers';
  actions.appendChild(btn);

  const why = document.createElement('button');
  why.type = 'button';
  why.textContent = 'Ask the LLM';
  why.addEventListener('click', ()=> openLLMChat(caseObj, 'mcq'));
  actions.appendChild(why);

  form.appendChild(actions);
  pane.appendChild(form);

  form.addEventListener('submit', e=>{
    e.preventDefault();
    gradeMCQs(caseObj, form);
  });
}

function gradeMCQs(caseObj, form){
  const spec = caseObj.mcqs;
  const cards = [...form.querySelectorAll('.mcq-card')];
  let nCorrect = 0;

  cards.forEach((card, idx)=>{
    const q = spec.questions[idx];
    if (!q) return;

    const selected = new Set([...card.querySelectorAll('input:checked')].map(i=>i.value));
    const correct  = new Set(q.choices.filter(c=>c.correct).map(c=>c.id));
    const allRight = selected.size === correct.size && [...selected].every(v => correct.has(v));
    if (allRight) nCorrect++;

    card.querySelectorAll('.mcq-choice').forEach(lbl=>{
      const val   = lbl.querySelector('input').value;
      const isSel = selected.has(val);
      const isCor = correct.has(val);
      lbl.classList.toggle('mcq-correct',  isSel && isCor);
      lbl.classList.toggle('mcq-wrong',    isSel && !isCor);
      lbl.classList.toggle('mcq-missed',  !isSel && isCor);
    });

    const expl = card.querySelector('.mcq-explain');
    const perChoice = q.choices
      .filter(c => c.explain && (correct.has(c.id) || selected.has(c.id)))
      .map(c => `• ${c.text}: ${c.explain}`);
    expl.innerHTML = perChoice.length
      ? `<div class="mcq-expl-title">Explanation</div><div>${perChoice.join('<br>')}</div>`
      : '';
    expl.classList.remove('hidden');
  });

  let scoreLine = form.querySelector('#mcqScoreLine');
  if (!scoreLine){
    scoreLine = document.createElement('div');
    scoreLine.id = 'mcqScoreLine';
    scoreLine.className = 'mcq-score';
    form.appendChild(scoreLine);
  }
  scoreLine.textContent = `Score: ${nCorrect} / ${cards.length}`;
}

/* ---------- LLM Chat (in-viewer panel) ---------- */
const chatDOM = {
  panel:   document.getElementById('llmPanel'),
  log:     document.getElementById('llmChatLog'),
  input:   document.getElementById('llmInput'),
  sendBtn: document.getElementById('llmSend'),
  hideBtn: document.getElementById('llmHide'),
};

let chatState = {
  kind: 'mcq',         // 'mcq' | 'oral'
  caseObj: null,
  qIndex: null,        // for MCQ
  messages: []         // {role:'system'|'user'|'assistant', content}
};

function bindLLMChatUI(){
  if (!chatDOM.panel) return;
  chatDOM.hideBtn?.addEventListener('click', ()=> {
    chatDOM.panel.style.display = 'none';
    chatDOM.hideBtn.style.display = 'none';
  });
  chatDOM.sendBtn?.addEventListener('click', onLLMSend);
  chatDOM.input?.addEventListener('keydown', (e) => {
    const k = e.key;
    if (
      k === ' ' || e.code === 'Space' || k === 'Spacebar' ||        // Space
      k === 'ArrowLeft' || k === 'ArrowRight' ||                    // Arrows
      k === 'PageUp' || k === 'PageDown' || k === 'Home' || k === 'End'
    ) {
      // DO NOT preventDefault — we want spaces/caret moves in the field.
      e.stopPropagation();  // just keep it from reaching global handlers
    }
  }, { capture: true });


  // Shield typing from global hotkeys: allow default in the input,
  // but stop the event from reaching document/window handlers.
  chatDOM.input?.addEventListener('keydown', (e) => {
    const k = e.key;
    if (
      k === ' ' || e.code === 'Space' || k === 'Spacebar' ||
      k === 'ArrowLeft' || k === 'ArrowRight' ||
      k === 'PageUp' || k === 'PageDown' || k === 'Home' || k === 'End'
    ) {
      // Do NOT preventDefault here—we want the character/caret to update.
      e.stopPropagation();
    }
  }, { capture: true });
}

function scrollChatToBottom(){
  if (chatDOM.log) chatDOM.log.scrollTop = chatDOM.log.scrollHeight;
}

function renderChat(){
  if (!chatDOM.log) return;
  chatDOM.log.innerHTML = chatState.messages
    .filter(m => m.role !== 'system')
    .map(m => m.role === 'assistant'
      ? `<div class="chat-assistant"><strong>Assistant:</strong> ${renderMarkdown(m.content)}</div>`
      : `<div class="chat-user"><strong>You:</strong> ${escapeWithBr(m.content)}</div>`
    ).join('');
  scrollChatToBottom();
}

/* Context helpers */
function getCurrentMCQContext(){
  const pane = document.getElementById('mcqPane');
  const form = pane?.querySelector('#mcqForm');
  if (!form) return { idx: 0, selectedText: [] };
  const cards = [...form.querySelectorAll('.mcq-card')];
  const idx = Math.max(0, cards.findIndex(c => c.querySelector('input:checked')));
  const selectedText = idx >= 0
    ? [...cards[idx].querySelectorAll('input:checked')].map(inp => {
        const lbl = inp.closest('label'); return lbl ? lbl.textContent.trim() : inp.value;
      })
    : [];
  return { idx: Math.max(0, idx), selectedText };
}
function getOralContext(){
  const tr = (typeof getTranscript === 'function') ? (getTranscript() || '').trim() : '';
  return { transcript: tr };
}

/* Open chat from either mode */
export function openLLMChat(caseObj, kind='mcq'){
  if (!chatDOM.panel) return;

  const spec = caseObj?.mcqs;

  chatState.kind    = kind;
  chatState.caseObj = caseObj;

  const lines = [`Case: ${caseObj.title || caseObj.id || ''}`];
  if (caseObj.boardPrompt) lines.push(`Clinical: ${caseObj.boardPrompt}`);

  if (kind === 'mcq' && spec?.questions?.length){
    const { idx, selectedText } = getCurrentMCQContext();
    chatState.qIndex = idx;
    const q = spec.questions[idx];
    if (q?.stem) lines.push(`Question: ${q.stem}`);
    if (q?.choices) lines.push(`Choices: ${q.choices.map(c=>c.text).join(' | ')}`);
    if (selectedText.length) lines.push(`Selected: ${selectedText.join(', ')}`);
  } else {
    chatState.qIndex = null;
    const { transcript } = getOralContext();
    if (transcript) lines.push(`Transcript:\n${transcript}`);
  }

  chatState.messages = [
    { role:'system', content: `You are an expert radiology boards coach. Be concise (4–7 sentences). Use imaging reasoning and contrast close distractors.`},
    { role:'user',   content: `Context for discussion:\n${lines.join('\n')}` },
    { role:'assistant', content: `Got it. What would you like to know about this ${kind === 'mcq' ? 'question' : 'case'}?` }
  ];

  renderChat();
  chatDOM.panel.style.display = 'block';
  chatDOM.hideBtn.style.display = 'inline-block';
  chatDOM.input?.focus();
}

async function onLLMSend(){
  const msg = (chatDOM.input?.value || '').trim();
  if (!msg) return;

  chatState.messages.push({ role: 'user', content: msg });
  chatDOM.input.value = '';
  renderChat();

  // temporary typing bubble
  chatState.messages.push({ role: 'assistant', content: '…' });
  renderChat();

  try {
    const reply = await callLLMChatAPI(chatState);
    chatState.messages.splice(-1, 1, { role: 'assistant', content: reply || '(no reply)' });
  } catch (e) {
    chatState.messages.splice(-1, 1, { role: 'assistant', content: `Sorry—couldn’t get a response (${e?.message || e}).` });
  } finally {
    renderChat();
  }
}

async function callLLMChatAPI(state){
  const c   = state.caseObj;
  const spec = c?.mcqs;
  const q   = (state.kind === 'mcq') ? (spec?.questions?.[state.qIndex] || null) : null;

  const selected = (state.kind === 'mcq')
    ? getCurrentMCQContext().selectedText
    : [];

  const payload = {
    mode: state.kind === 'mcq' ? 'mcq_chat' : 'oral_chat',
    caseId: c?.id,
    title: c?.title,
    subspecialty: c?.subspecialty,
    boardPrompt: c?.boardPrompt,
    expectedAnswer: c?.expectedAnswer,
    question: q?.stem || null,
    choices: q?.choices ? q.choices.map(ch=>ch.text) : [],
    selected,
    transcript: state.kind === 'oral' ? (getOralContext().transcript || '') : '',
    messages: state.messages.filter(m => m.role !== 'system')
  };

  // Prefer dedicated chat API, else fall back to FEEDBACK_API
  const url = (CONFIG?.MCQ_CHAT_API || CONFIG?.FEEDBACK_API || '').trim();
  if (!url) throw new Error('No API configured (MCQ_CHAT_API / FEEDBACK_API).');

  const headers = {
    'Content-Type': 'application/json',
    ...(CONFIG?.API_KEY ? {'x-api-key': CONFIG.API_KEY} : {}),
    ...(CONFIG?.JWT ? { 'Authorization': `Bearer ${CONFIG.JWT}` } : {})
  };

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) {
    const msg = (data && (data.detail || data.error || data.message)) || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  const text = (data && (data.reply || data.message || data.feedback || data.explanation)) || '';
  return (typeof text === 'string' && text.trim()) ? text.trim() : '(empty reply)';
}

/* ---------- Utils ---------- */
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }