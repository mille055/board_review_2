import { SUBS, CONFIG } from './config.js';
import { getAll, setCases } from './store.js';
import { openViewer as openViewerBase } from './viewer.js';
import { toggleMic, getTranscript } from './speech.js';
import { gradeHeuristic, heuristicFeedback, buildLLMPayload, letter } from './grade.js';
import { recordAttempt, getStats } from './progress.js';

const chips   = document.getElementById('chips');
const grid    = document.getElementById('grid');
const countEl = document.getElementById('count');

const vFeedback = document.getElementById('vFeedback');
const vScore    = document.getElementById('vScore');
const vLLM      = document.getElementById('vLLM');

// ===== Mode (oral | mcq) =====
let mode = (localStorage.getItem('mode') || 'oral');

/* ---------- Local filter state ---------- */
let activeSubs = new Set();
let queryStr   = "";

/* ---------- Helpers ---------- */
function setToggleChecked(on){
  const a = document.getElementById('modeToggle');
  if (a) a.checked = !!on;
}

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

  document.getElementById('q').addEventListener('input', e=>{
    queryStr = (e.target.value || '').trim().toLowerCase();
    render();
  });
  document.getElementById('clear').onclick=()=>{
    document.getElementById('q').value='';
    queryStr='';
    render();
  };

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

  document.getElementById('importBtn').onclick=()=>document.getElementById('fileInput').click();
  document.getElementById('fileInput').addEventListener('change', async (e)=>{
    const file = e.target.files[0]; if(!file) return;
    try{
      const json = JSON.parse(await file.text());
      if(Array.isArray(json)){ setCases(json); render(); alert(`Imported ${json.length} cases ✔`); }
      else { alert('JSON must be an array of cases'); }
    }catch{ alert('Invalid JSON'); }
  });

  // Add this after the initUI function
  async function refreshSignedUrls() {
    const token = localStorage.getItem('jwt');
    if (!token) return;
    
    const cases = getAll();
    if (!cases.length) return;
    
    console.log('Refreshing signed URLs for', cases.length, 'cases...');
    
    const refreshedCases = await Promise.all(
      cases.map(async (c) => {
        if (c.images && c.images.length > 0 && c.images[0].includes('s3.amazonaws.com')) {
          try {
            const response = await fetch(`${CONFIG.API_BASE}/api/cases/${c.id}/signed`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (response.ok) {
              return await response.json();
            }
          } catch (err) {
            console.warn(`Failed to refresh signed URLs for ${c.id}`);
          }
        }
        return c;
      })
    );
    
    setCases(refreshedCases);
    render();
    console.log('✓ Signed URLs refreshed');
  }

  // UPDATED: Load cases from API with signed URLs
  document.getElementById('loadSamples').onclick = async ()=>{
    try {
      const token = localStorage.getItem('jwt');
      if (!token) {
        alert('Please log in first to load cases.');
        return;
      }
      
      // Fetch all cases from the API
      const response = await fetch(`${CONFIG.API_BASE}/api/cases`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to load cases: ${response.status}`);
      }
      
      const cases = await response.json();
      
      // Now fetch signed URLs for each case
      const casesWithSignedUrls = await Promise.all(
        cases.map(async (c) => {
          if (c.images && c.images.length > 0 && c.images[0].includes('s3.amazonaws.com')) {
            try {
              const signedResponse = await fetch(`${CONFIG.API_BASE}/api/cases/${c.id}/signed`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              
              if (signedResponse.ok) {
                return await signedResponse.json();
              }
            } catch (err) {
              console.warn(`Failed to get signed URLs for ${c.id}:`, err);
            }
          }
          return c;
        })
      );
      
      setCases(casesWithSignedUrls);
      render();
      alert(`Loaded ${casesWithSignedUrls.length} cases ✔`);
    } catch (error) {
      console.error('Failed to load cases:', error);
      alert(`Failed to load cases: ${error.message}`);
    }
  };

  document.getElementById('vMicBtn')?.addEventListener('click', toggleMic);

  document.getElementById('gradeBtn')?.addEventListener('click', async ()=>{
    const transcriptEl = document.getElementById('vTranscript');
    const tr = transcriptEl ? transcriptEl.value.trim() : '';
  
    console.log('Transcript element:', transcriptEl);
    console.log('Transcript value:', tr);
  
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

  // Bridge to viewer (and MCQ renderer) - WITH SIGNED URLs
  window.openViewer = async (c)=>{
    console.log('Opening case:', c.id);
    
    // Fetch case with signed URLs if S3 images are present
    let caseToOpen = c;
    if (c.images && c.images.length > 0 && c.images[0].includes('s3.amazonaws.com')) {
        try {
            const token = localStorage.getItem('jwt');
            const response = await fetch(`${CONFIG.API_BASE}/api/cases/${c.id}/signed`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (response.ok) {
                caseToOpen = await response.json();
                console.log('✓ Loaded case with signed URLs');
            } else {
                console.warn('Failed to get signed URLs, using original URLs');
            }
        } catch (error) {
            console.error('Failed to load signed URLs:', error);
            // Fall back to original case
        }
    }
    
    window.__currentCaseForGrading = caseToOpen;
    openViewerBase(caseToOpen);

    if (mode === 'mcq' && !(caseToOpen?.mcqs?.questions?.length)) {
      mode = 'oral';
      localStorage.setItem('mode', mode);
    }

    setToggleChecked(mode === 'mcq');
    renderMode();
    if (mode === 'mcq') renderMCQs(caseToOpen); else clearMCQs();
  };

  bindLLMChatUI();
  document.getElementById('llmAskBtnOral')?.addEventListener('click', ()=>{
    const c = window.__currentCaseForGrading;
    if (!c) return alert('Open a case first.');
    openLLMChat(c, 'oral');
  });

  bindModeToggle();
  renderMode();
  render();
  refreshSignedUrls();
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
  if (!pane) return;
  pane.innerHTML = '';

  const spec = caseObj.mcqs;
  if (!spec || !spec.questions || !spec.questions.length){
    pane.innerHTML = '<div class="small muted">No multiple-choice questions for this case.</div>';
    return;
  }

  const form = document.createElement('form'); form.id = 'mcqForm';
  spec.questions.forEach((q, qIdx)=>{
    const card = document.createElement('div'); card.className = 'mcq-card';
    const stem = document.createElement('div'); stem.className = 'mcq-stem';
    stem.textContent = `${qIdx+1}. ${q.stem}`;
    card.appendChild(stem);

    q.choices.forEach(ch=>{
      const lbl = document.createElement('label'); lbl.className = 'mcq-choice';
      const inp = document.createElement('input');
      inp.type = q.multi_select ? 'checkbox' : 'radio';
      inp.name = 'q'+qIdx;
      inp.value = ch.id;
      lbl.appendChild(inp);
      const txt = document.createElement('span'); txt.textContent = ch.text;
      lbl.appendChild(txt);
      card.appendChild(lbl);
    });

    const expl = document.createElement('div'); expl.className = 'mcq-explain hidden';
    card.appendChild(expl);
    form.appendChild(card);
  });

  const actions = document.createElement('div'); actions.className = 'mcq-actions';
  const submit = document.createElement('button'); submit.type = 'submit';
  submit.className = 'btn'; submit.textContent = 'Grade';
  actions.appendChild(submit);

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
  kind: 'mcq',
  caseObj: null,
  qIndex: null,
  messages: []
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
      k === ' ' || e.code === 'Space' || k === 'Spacebar' ||
      k === 'ArrowLeft' || k === 'ArrowRight' ||
      k === 'PageUp' || k === 'PageDown' || k === 'Home' || k === 'End'
    ) {
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

  chatState.messages.push({ role: 'assistant', content: '…' });
  renderChat();

  try {
    const reply = await callLLMChatAPI(chatState);
    chatState.messages.splice(-1, 1, { role: 'assistant', content: reply || '(no reply)' });
  } catch (e) {
    chatState.messages.splice(-1, 1, { role: 'assistant', content: `Sorry—couldn't get a response (${e?.message || e}).` });
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

  const url = (CONFIG?.MCQ_CHAT_API || CONFIG?.FEEDBACK_API || '').trim();
  if (!url) throw new Error('No API configured (MCQ_CHAT_API / FEEDBACK_API).');

  const token = localStorage.getItem('jwt');
  const headers = {
    'Content-Type': 'application/json'
  };
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (CONFIG?.API_KEY) {
    headers['x-api-key'] = CONFIG.API_KEY;
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) {
    const msg = (data && (data.detail || data.error || data.message)) || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  const text = (data && (data.reply || data.message || data.feedback || data.explanation)) || '';
  return (typeof text === 'string' && text.trim()) ? text.trim() : '(empty reply)';
}

function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }