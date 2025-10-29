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

// ===== Mode (oral | mcq) =====
let mode = (localStorage.getItem('mode') || 'oral');

/* ---------- Local filter state ---------- */
let activeSubs = new Set();
let queryStr   = "";

/* ---------- Admin check ---------- */
let currentUser = null;

async function fetchCurrentUser() {
  const token = localStorage.getItem('jwt');
  if (!token) return null;
  
  try {
    const response = await fetch(`${CONFIG.API_BASE}/api/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (response.ok) {
      currentUser = await response.json();
      console.log('Current user:', currentUser);
      return currentUser;
    }
  } catch (e) {
    console.error('Failed to fetch user info:', e);
  }
  return null;
}

function isAdmin() {
  return currentUser?.isAdmin || false;
}

function updateAdminUI() {
  const adminLink = document.getElementById('adminLink');
  if (adminLink) {
    adminLink.style.display = isAdmin() ? 'inline-block' : 'none';
  }
}

/* ---------- Admin Mode State ---------- */
let selectedCases = new Set();
let isAdminMode = false;

/* ---------- Toggle Admin Mode ---------- */
function toggleAdminMode() {
  isAdminMode = !isAdminMode;
  selectedCases.clear();
  render();
  
  const btn = document.getElementById('toggleAdminMode');
  if (btn) {
    btn.textContent = isAdminMode ? 'Exit Edit Mode' : 'Edit Cases';
    btn.className = isAdminMode ? 'btn' : 'btn ghost';
  }
}

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

/* ---------- Sort cases by title ---------- */
function sortCasesByTitle(cases) {
  return cases.sort((a, b) => {
    const aNum = parseInt(a.title.match(/\d+/)?.[0] || '999');
    const bNum = parseInt(b.title.match(/\d+/)?.[0] || '999');
    return aNum - bNum;
  });
}

/* ---------- Load cases from database with signed URLs ---------- */
async function loadCasesFromDatabase() {
  try {
    const token = localStorage.getItem('jwt');
    if (!token) {
      console.log('No JWT token, skipping auto-load');
      return;
    }
    
    console.log('Loading cases from database...');
    
    const response = await fetch(`${CONFIG.API_BASE}/api/cases`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) {
      console.warn('Failed to load cases:', response.status);
      return;
    }
    
    let cases = await response.json();
    cases = sortCasesByTitle(cases);
    
    console.log(`Processing ${cases.length} cases for signed URLs...`);
    
    const casesWithSignedUrls = await Promise.all(
      cases.map(async (c) => {
        // Check if any image URLs contain s3.amazonaws.com (need signing)
        const needsSigning = c.images && c.images.length > 0 && 
          c.images.some(img => img && img.includes('s3.amazonaws.com'));
        
        if (needsSigning) {
          try {
            console.log(`🔍 Requesting signed URLs for ${c.id}...`);
            const signedResponse = await fetch(`${CONFIG.API_BASE}/api/cases/${c.id}/signed`, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            
            if (signedResponse.ok) {
              const contentType = signedResponse.headers.get('content-type');
              if (contentType && contentType.includes('application/json')) {
                const signedCase = await signedResponse.json();
                console.log(`✅ Got signed URLs for ${c.id}:`, signedCase.images?.[0]?.substring(0, 100) + '...');
                return signedCase;
              } else {
                const text = await signedResponse.text();
                console.error(`❌ Non-JSON response for ${c.id}:`, text.substring(0, 300));
              }
            } else {
              const errorText = await signedResponse.text();
              console.error(`❌ Signed URL request failed for ${c.id} (${signedResponse.status}):`, errorText.substring(0, 300));
            }
          } catch (err) {
            console.error(`❌ Error getting signed URLs for ${c.id}:`, err.message);
          }
        }
        return c;
      })
    );
    
    setCases(casesWithSignedUrls);
    render();
    console.log(`✓ Loaded ${casesWithSignedUrls.length} cases from database`);
  } catch (error) {
    console.error('Failed to load cases from database:', error);
  }
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

/* ---------- Render markdown helpers ---------- */
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

/* ---------- Helper: Escape HTML ---------- */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/* ---------- Show/Hide Answer functionality ---------- */
function setupShowAnswerButton(caseObj) {
  const showAnswerBtn = document.getElementById('showAnswerBtn');
  const answerSection = document.getElementById('answerSection');
  const vAnswer = document.getElementById('vAnswer');
  const vRubric = document.getElementById('vRubric');
  
  if (!showAnswerBtn || !answerSection) return;
  
  if (isAdmin()) {
    showAnswerBtn.style.display = 'none';
    answerSection.style.display = 'block';
  } else {
    let isShown = false;
    showAnswerBtn.style.display = 'block';
    answerSection.style.display = 'none';
    
    showAnswerBtn.onclick = () => {
      isShown = !isShown;
      answerSection.style.display = isShown ? 'block' : 'none';
      showAnswerBtn.textContent = isShown ? 'Hide Answer & Rubric' : 'Show Answer & Rubric';
    };
  }
  
  if (vAnswer) vAnswer.textContent = caseObj.expectedAnswer || 'No answer provided';
  if (vRubric) {
    vRubric.innerHTML = (caseObj.rubric || []).map(r => `• ${r}`).join('<br>');
  }
}

/* ---------- LLM Chat setup ---------- */
function setupLLMChat() {
  const llmAskBtn = document.getElementById('llmAskBtn');
  const llmPanel = document.getElementById('llmPanel');
  const llmHide = document.getElementById('llmHide');
  
  if (llmAskBtn && llmPanel && llmHide) {
    llmAskBtn.onclick = () => {
      const c = window.__currentCaseForGrading;
      if (!c) return alert('Open a case first.');
      llmPanel.style.display = 'block';
      llmAskBtn.style.display = 'none';
      openLLMChat(c, mode === 'mcq' ? 'mcq' : 'oral');
    };
    
    llmHide.onclick = () => {
      llmPanel.style.display = 'none';
      llmAskBtn.style.display = 'block';
    };
  }
}

/* ---------- Delete Single Case (Soft Delete) ---------- */
async function deleteCase(caseId) {
  if (!confirm('Move this case to trash? You can restore it later.')) return;
  
  try {
    const token = localStorage.getItem('jwt');
    const response = await fetch(`${CONFIG.API_BASE}/api/cases/${caseId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to delete: ${response.status}`);
    }
    
    alert('Case moved to trash (click 🗑️ Trash to restore)');
    await loadCasesFromDatabase();
  } catch (error) {
    console.error('Delete failed:', error);
    alert(`Failed to delete case: ${error.message}`);
  }
}

/* ---------- Bulk Delete Cases ---------- */
async function bulkDeleteCases() {
  const count = selectedCases.size;
  if (!confirm(`Move ${count} selected case(s) to trash? You can restore them later.`)) return;
  
  try {
    const token = localStorage.getItem('jwt');
    const deletePromises = Array.from(selectedCases).map(caseId =>
      fetch(`${CONFIG.API_BASE}/api/cases/${caseId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
    );
    
    await Promise.all(deletePromises);
    
    alert(`Moved ${count} case(s) to trash`);
    selectedCases.clear();
    isAdminMode = false;
    await loadCasesFromDatabase();
  } catch (error) {
    console.error('Bulk delete failed:', error);
    alert(`Failed to delete cases: ${error.message}`);
  }
}

/* ---------- Open Edit Case Modal ---------- */
async function openEditCaseModal(caseData) {
  // Fetch fresh case data from database to get latest MCQs and rubric
  let freshCaseData = caseData;
  try {
    const token = localStorage.getItem('jwt');
    const response = await fetch(`${CONFIG.API_BASE}/api/cases/${caseData.id}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (response.ok) {
      freshCaseData = await response.json();
      console.log('✓ Loaded fresh case data:', freshCaseData);
    }
  } catch (error) {
    console.error('Failed to fetch fresh case data:', error);
    // Fall back to cached data
  }
  
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.display = 'block';
  
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-inner" style="max-width:900px; max-height:90vh; overflow-y:auto;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
        <h3 style="margin:0;">Edit Case: ${escapeHtml(freshCaseData.title)}</h3>
        <button class="btn ghost" id="closeEditModal">Close</button>
      </div>
      
      <form id="editCaseForm">
        <div style="display:grid; gap:16px;">
          <div>
            <label class="label">Title *</label>
            <input type="text" name="title" class="input" required value="${escapeHtml(freshCaseData.title || '')}">
          </div>
          
          <div>
            <label class="label">Subspecialty *</label>
            <select name="subspecialty" class="input" required>
              ${SUBS.map(s => `<option value="${s}" ${s === freshCaseData.subspecialty ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          
          <div>
            <label class="label">Clinical History / Board Prompt *</label>
            <textarea name="boardPrompt" class="input" rows="4" required>${escapeHtml(freshCaseData.boardPrompt || '')}</textarea>
          </div>
          
          <div>
            <label class="label">Expected Answer *</label>
            <textarea name="expectedAnswer" class="input" rows="6" required>${escapeHtml(freshCaseData.expectedAnswer || '')}</textarea>
          </div>
          
          <div style="border-top:1px solid #ddd; padding-top:16px; margin-top:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
              <label class="label" style="margin:0;">Rubric / Key Points</label>
              <div style="display:flex; gap:8px;">
                <button type="button" class="btn ghost" id="batchImportRubricBtn">📋 Batch Import</button>
                <button type="button" class="btn ghost" id="addBlankRubricBtn">+ Add Point</button>
                <button type="button" class="btn ghost" id="generateRubricBtn">✨ Generate with AI</button>
              </div>
            </div>
            <div id="rubricEditor" style="background:#0f1013; padding:16px; border-radius:8px; border:1px solid #2a2a2f; min-height:100px;">
              <!-- Rubric points will be rendered here -->
            </div>
          </div>
          
          <div>
            <label class="label">Tags (comma-separated)</label>
            <input type="text" name="tags" class="input" value="${(freshCaseData.tags || []).join(', ')}">
          </div>
          
          <div>
            <label class="label">Image URLs (one per line)</label>
            <textarea name="images" class="input" rows="4" placeholder="https://...&#10;https://...">${(freshCaseData.images || []).join('\n')}</textarea>
          </div>
          
          <div style="border-top:1px solid #ddd; padding-top:16px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
              <label class="label" style="margin:0;">Multiple Choice Questions</label>
              <div style="display:flex; gap:8px;">
                <button type="button" class="btn ghost" id="addBlankMCQBtn">+ Add Blank Question</button>
                <button type="button" class="btn ghost" id="generateOneMCQBtn">✨ Generate 1 MCQ</button>
                <button type="button" class="btn ghost" id="generateMCQBtn">✨ Generate 3-5 MCQs</button>
              </div>
            </div>
            <div id="mcqEditor"></div>
          </div>
          
          <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:16px;">
            <button type="button" class="btn ghost" id="cancelEdit">Cancel</button>
            <button type="submit" class="btn">Save Changes</button>
          </div>
        </div>
      </form>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Set current MCQs and Rubric for editing (use fresh data!)
  window.currentMCQs = freshCaseData.mcqs || { questions: [] };
  window.currentRubric = freshCaseData.rubric || [];
  window.currentCaseForMCQEdit = freshCaseData;
  renderMCQEditor(window.currentMCQs);
  renderRubricEditor(window.currentRubric);
  
  // Bind events
  document.getElementById('closeEditModal').onclick = () => modal.remove();
  document.getElementById('cancelEdit').onclick = () => modal.remove();
  document.getElementById('addBlankMCQBtn').onclick = () => openBlankMCQComposer();
  document.getElementById('generateOneMCQBtn').onclick = () => generateMCQs(freshCaseData, 1);
  document.getElementById('generateMCQBtn').onclick = () => generateMCQs(freshCaseData, 5);
  document.getElementById('addBlankRubricBtn').onclick = () => addBlankRubricPoint();
  document.getElementById('generateRubricBtn').onclick = () => generateRubric(freshCaseData);
  document.getElementById('batchImportRubricBtn').onclick = () => openBatchImportDialog();
  
  document.getElementById('editCaseForm').onsubmit = async (e) => {
    e.preventDefault();
    await saveEditedCase(freshCaseData.id, e.target);
    modal.remove();
  };
  
  modal.querySelector('.modal-backdrop').onclick = () => modal.remove();
}

/* ---------- Render Rubric Editor ---------- */
function renderRubricEditor(rubricPoints) {
  const editor = document.getElementById('rubricEditor');
  if (!editor) return;
  
  if (!rubricPoints || rubricPoints.length === 0) {
    editor.innerHTML = '<div class="small" style="color:#999; padding:20px; text-align:center;">No rubric points yet. Click "Generate with AI" or "Add Point" to create some.</div>';
    return;
  }
  
  editor.innerHTML = rubricPoints.map((point, idx) => `
    <div class="box" style="margin-bottom:8px; display:flex; gap:8px; align-items:start; background:#1a1a1f; border:1px solid #2a2a2f;">
      <span style="color:#666; min-width:24px; margin-top:8px;">${idx + 1}.</span>
      <textarea class="input rubric-point" data-idx="${idx}" rows="2" style="flex:1; background:#0f1013; border:1px solid #2a2a2f;">${escapeHtml(point)}</textarea>
      <button type="button" class="btn ghost" style="padding:4px 8px; margin-top:4px;" onclick="removeRubricPoint(${idx})">✕</button>
    </div>
  `).join('');
}

/* ---------- Rubric Editor Functions ---------- */
window.currentRubric = [];

function addBlankRubricPoint() {
  if (!window.currentRubric) window.currentRubric = [];
  window.currentRubric.push('');
  renderRubricEditor(window.currentRubric);
  
  // Focus on the new point
  setTimeout(() => {
    const newPoint = document.querySelector(`.rubric-point[data-idx="${window.currentRubric.length - 1}"]`);
    if (newPoint) newPoint.focus();
  }, 50);
}

window.removeRubricPoint = function(idx) {
  if (!window.currentRubric) return;
  window.currentRubric.splice(idx, 1);
  renderRubricEditor(window.currentRubric);
};

/* ---------- Collect Rubric Data ---------- */
function collectRubricData() {
  const points = [];
  document.querySelectorAll('.rubric-point').forEach((textarea) => {
    const text = textarea.value.trim();
    if (text) {
      points.push(text);
    }
  });
  return points;
}

/* ---------- Open Batch Import Dialog ---------- */
function openBatchImportDialog() {
  const importModal = document.createElement('div');
  importModal.className = 'modal';
  importModal.style.display = 'block';
  
  importModal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-inner" style="max-width:700px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
        <h3 style="margin:0;">Batch Import Rubric Points</h3>
        <button class="btn ghost" id="closeImport">Close</button>
      </div>
      
      <div style="margin-bottom:16px;">
        <p style="color:#999; margin-bottom:12px;">
          Paste your rubric points below. They will be automatically split by:
          <br>• New lines
          <br>• Bullet points (•, -, *, >)
          <br>• Numbers (1., 2., etc.)
          <br>• Semicolons (;)
        </p>
      </div>
      
      <form id="importForm">
        <div style="margin-bottom:16px;">
          <label class="label">Paste Rubric Points</label>
          <textarea 
            id="batchImportText" 
            class="input" 
            rows="12" 
            style="background:#0f1013; border:1px solid #2a2a2f; font-family:monospace;"
            placeholder="Paste your rubric points here, for example:

• Identifies study type (e.g., CT abdomen/pelvis with contrast)
• Describes key imaging findings
• Provides differential diagnosis (at least 2-3 possibilities)
• States most likely diagnosis with supporting evidence
• Discusses management or next steps

Or:

1. Names study type
2. Describes key findings
3. Gives differential diagnosis"></textarea>
        </div>
        
        <div style="display:flex; gap:8px; justify-content:space-between; align-items:center;">
          <button type="button" class="btn ghost" id="previewSplit">
            👁️ Preview Split (0)
          </button>
          <div style="display:flex; gap:8px;">
            <button type="button" class="btn ghost" id="cancelImport">Cancel</button>
            <button type="submit" class="btn">Import Points</button>
          </div>
        </div>
        
        <div id="previewArea" style="margin-top:16px; padding:12px; background:#1a1a1f; border:1px solid #2a2a2f; border-radius:8px; display:none;">
          <div style="color:#999; margin-bottom:8px; font-size:12px;">PREVIEW:</div>
          <div id="previewList"></div>
        </div>
      </form>
    </div>
  `;
  
  document.body.appendChild(importModal);
  
  const textarea = document.getElementById('batchImportText');
  const previewBtn = document.getElementById('previewSplit');
  const previewArea = document.getElementById('previewArea');
  const previewList = document.getElementById('previewList');
  
  // Update preview button text on input
  textarea.addEventListener('input', () => {
    const points = splitRubricText(textarea.value);
    previewBtn.textContent = `👁️ Preview Split (${points.length} point${points.length === 1 ? '' : 's'})`;
  });
  
  // Preview button
  previewBtn.onclick = () => {
    const points = splitRubricText(textarea.value);
    if (points.length === 0) {
      previewList.innerHTML = '<div style="color:#999;">No points detected. Try pasting some text above.</div>';
    } else {
      previewList.innerHTML = points.map((p, i) => 
        `<div style="padding:4px 0; border-bottom:1px solid #2a2a2f;">
          <span style="color:#666;">${i + 1}.</span> ${escapeHtml(p)}
        </div>`
      ).join('');
    }
    previewArea.style.display = 'block';
  };
  
  // Bind events
  document.getElementById('closeImport').onclick = () => importModal.remove();
  document.getElementById('cancelImport').onclick = () => importModal.remove();
  importModal.querySelector('.modal-backdrop').onclick = () => importModal.remove();
  
  // Form submit
  document.getElementById('importForm').onsubmit = (e) => {
    e.preventDefault();
    
    const text = textarea.value.trim();
    if (!text) {
      alert('Please paste some text to import');
      return;
    }
    
    const points = splitRubricText(text);
    
    if (points.length === 0) {
      alert('No rubric points detected. Try formatting with bullet points or line breaks.');
      return;
    }
    
    // Append to existing rubric
    if (!window.currentRubric) window.currentRubric = [];
    window.currentRubric.push(...points);
    
    renderRubricEditor(window.currentRubric);
    importModal.remove();
    alert(`Imported ${points.length} rubric point${points.length === 1 ? '' : 's'}!`);
  };
}

/* ---------- Split Rubric Text into Points ---------- */
function splitRubricText(text) {
  if (!text || !text.trim()) return [];
  
  // Split by multiple delimiters
  let points = text
    // First split by semicolons
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .flatMap(section => {
      // Then split each section by newlines
      return section.split('\n');
    })
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      // Remove common prefixes
      return line
        // Remove bullets: •, -, *, >, ◦
        .replace(/^[•\-*>◦]\s*/, '')
        // Remove numbers: 1., 2), etc.
        .replace(/^\d+[\.)]\s*/, '')
        // Remove parentheses: (1), [a], etc.
        .replace(/^[\(\[]\w+[\)\]]\s*/, '')
        .trim();
    })
    .filter(line => line.length > 3); // Ignore very short fragments
  
  // Remove duplicates while preserving order
  const seen = new Set();
  points = points.filter(point => {
    const normalized = point.toLowerCase().trim();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
  
  return points;
}

/* ---------- Generate Rubric with AI ---------- */
async function generateRubric(caseData) {
  const btn = document.getElementById('generateRubricBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Generating...';
  }
  
  try {
    const token = localStorage.getItem('jwt');
    const response = await fetch(`${CONFIG.API_BASE}/api/cases/${caseData.id}/generate-rubric`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: caseData.title,
        boardPrompt: caseData.boardPrompt,
        expectedAnswer: caseData.expectedAnswer,
        subspecialty: caseData.subspecialty
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to generate rubric: ${response.status}`);
    }
    
    const result = await response.json();
    const newPoints = result.rubric || [];
    
    if (newPoints.length === 0) {
      throw new Error('No rubric points generated');
    }
    
    // Ask user if they want to replace or append
    const action = confirm(
      `Generated ${newPoints.length} rubric points!\n\n` +
      `You currently have ${window.currentRubric?.length || 0} points.\n\n` +
      `Click OK to ADD these to existing points.\n` +
      `Click Cancel to REPLACE all points with the new ones.`
    );
    
    if (action) {
      // Append to existing
      if (!window.currentRubric) window.currentRubric = [];
      window.currentRubric.push(...newPoints);
    } else {
      // Replace all
      window.currentRubric = newPoints;
    }
    
    renderRubricEditor(window.currentRubric);
    
  } catch (error) {
    console.error('Rubric generation failed:', error);
    alert(`Failed to generate rubric: ${error.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '✨ Generate with AI';
    }
  }
}

/* ---------- Render MCQ Editor ---------- */
function renderMCQEditor(mcqs) {
  const editor = document.getElementById('mcqEditor');
  if (!editor) return;
  
  if (!mcqs || !mcqs.questions || mcqs.questions.length === 0) {
    editor.innerHTML = '<div class="small" style="color:#999;">No MCQs yet. Click "Generate MCQs with AI" to create some.</div>';
    return;
  }
  
  editor.innerHTML = mcqs.questions.map((q, qIdx) => `
    <div class="box" style="margin-bottom:12px; position:relative;">
      <button type="button" class="btn ghost" style="position:absolute; top:8px; right:8px; padding:4px 8px;" 
              onclick="removeMCQ(${qIdx})">✕</button>
      
      <div style="margin-bottom:12px;">
        <label class="label">Question ${qIdx + 1}</label>
        <textarea class="input mcq-stem" data-idx="${qIdx}" rows="2">${escapeHtml(q.stem || '')}</textarea>
      </div>
      
      <div style="margin-bottom:8px;">
        <label class="label">Answer Choices</label>
        ${q.choices.map((ch, chIdx) => `
          <div style="display:flex; gap:8px; margin-bottom:8px; align-items:start;">
            <input type="checkbox" ${ch.correct ? 'checked' : ''} 
                   class="mcq-correct" data-qidx="${qIdx}" data-chidx="${chIdx}"
                   style="margin-top:8px;">
            <input type="text" class="input mcq-choice-text" 
                   data-qidx="${qIdx}" data-chidx="${chIdx}"
                   value="${escapeHtml(ch.text || '')}" 
                   placeholder="Choice ${String.fromCharCode(65 + chIdx)}"
                   style="flex:1;">
            <button type="button" class="btn ghost" style="padding:4px 8px;" 
                    onclick="removeChoice(${qIdx}, ${chIdx})">✕</button>
          </div>
        `).join('')}
        <button type="button" class="btn ghost" onclick="addChoice(${qIdx})">+ Add Choice</button>
      </div>
      
      <div>
        <label class="label">Explanation (optional)</label>
        <textarea class="input mcq-explanation" data-idx="${qIdx}" rows="2" placeholder="Why the correct answer(s) are correct...">${escapeHtml(q.explanation || '')}</textarea>
      </div>
    </div>
  `).join('') + `
    <button type="button" class="btn ghost" onclick="addMCQ()">+ Add Question</button>
  `;
}

/* ---------- MCQ Editor Functions ---------- */
window.currentMCQs = null;

window.addMCQ = function() {
  if (!window.currentMCQs) window.currentMCQs = { questions: [] };
  window.currentMCQs.questions.push({
    stem: '',
    multi_select: false,
    choices: [
      { id: 'a', text: '', correct: false },
      { id: 'b', text: '', correct: false }
    ],
    explanation: ''
  });
  renderMCQEditor(window.currentMCQs);
};

window.removeMCQ = function(qIdx) {
  if (!window.currentMCQs) return;
  window.currentMCQs.questions.splice(qIdx, 1);
  renderMCQEditor(window.currentMCQs);
};

window.addChoice = function(qIdx) {
  if (!window.currentMCQs) return;
  const q = window.currentMCQs.questions[qIdx];
  const nextId = String.fromCharCode(97 + q.choices.length);
  q.choices.push({ id: nextId, text: '', correct: false });
  renderMCQEditor(window.currentMCQs);
};

window.removeChoice = function(qIdx, chIdx) {
  if (!window.currentMCQs) return;
  window.currentMCQs.questions[qIdx].choices.splice(chIdx, 1);
  renderMCQEditor(window.currentMCQs);
};

/* ---------- Open Blank MCQ Composer ---------- */
function openBlankMCQComposer() {
  const composerModal = document.createElement('div');
  composerModal.className = 'modal';
  composerModal.style.display = 'block';
  
  composerModal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-inner" style="max-width:800px; max-height:90vh; overflow-y:auto;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
        <h3 style="margin:0;">Compose New MCQ</h3>
        <button class="btn ghost" id="closeComposer">Close</button>
      </div>
      
      <form id="composerForm">
        <div style="display:grid; gap:16px;">
          <div>
            <label class="label">Question Stem *</label>
            <textarea name="stem" class="input" rows="3" required placeholder="What is the most likely diagnosis?"></textarea>
          </div>
          
          <div>
            <label class="label">Answer Choices</label>
            <div id="composerChoices">
              <div style="display:flex; gap:8px; margin-bottom:8px; align-items:start;">
                <input type="checkbox" class="composer-correct" data-idx="0" style="margin-top:8px;">
                <input type="text" class="input composer-choice" data-idx="0" placeholder="Choice A" style="flex:1;">
              </div>
              <div style="display:flex; gap:8px; margin-bottom:8px; align-items:start;">
                <input type="checkbox" class="composer-correct" data-idx="1" style="margin-top:8px;">
                <input type="text" class="input composer-choice" data-idx="1" placeholder="Choice B" style="flex:1;">
              </div>
              <div style="display:flex; gap:8px; margin-bottom:8px; align-items:start;">
                <input type="checkbox" class="composer-correct" data-idx="2" style="margin-top:8px;">
                <input type="text" class="input composer-choice" data-idx="2" placeholder="Choice C" style="flex:1;">
              </div>
              <div style="display:flex; gap:8px; margin-bottom:8px; align-items:start;">
                <input type="checkbox" class="composer-correct" data-idx="3" style="margin-top:8px;">
                <input type="text" class="input composer-choice" data-idx="3" placeholder="Choice D" style="flex:1;">
              </div>
            </div>
            <button type="button" class="btn ghost" id="addComposerChoice">+ Add Choice</button>
          </div>
          
          <div>
            <label class="label">Explanation (optional)</label>
            <textarea name="explanation" class="input" rows="3" placeholder="Why the correct answer is correct..."></textarea>
          </div>
          
          <div style="display:flex; gap:8px; justify-content:flex-end;">
            <button type="button" class="btn ghost" id="cancelComposer">Cancel</button>
            <button type="submit" class="btn">Add Question</button>
          </div>
        </div>
      </form>
    </div>
  `;
  
  document.body.appendChild(composerModal);
  
  // Bind events
  document.getElementById('closeComposer').onclick = () => composerModal.remove();
  document.getElementById('cancelComposer').onclick = () => composerModal.remove();
  composerModal.querySelector('.modal-backdrop').onclick = () => composerModal.remove();
  
  // Add choice button
  let choiceCount = 4;
  document.getElementById('addComposerChoice').onclick = () => {
    const choicesDiv = document.getElementById('composerChoices');
    const newChoice = document.createElement('div');
    newChoice.style.cssText = 'display:flex; gap:8px; margin-bottom:8px; align-items:start;';
    newChoice.innerHTML = `
      <input type="checkbox" class="composer-correct" data-idx="${choiceCount}" style="margin-top:8px;">
      <input type="text" class="input composer-choice" data-idx="${choiceCount}" placeholder="Choice ${String.fromCharCode(65 + choiceCount)}" style="flex:1;">
      <button type="button" class="btn ghost" onclick="this.parentElement.remove()" style="padding:4px 8px;">✕</button>
    `;
    choicesDiv.appendChild(newChoice);
    choiceCount++;
  };
  
  // Form submit
  document.getElementById('composerForm').onsubmit = (e) => {
    e.preventDefault();
    
    const formData = new FormData(e.target);
    const stem = formData.get('stem').trim();
    const explanation = formData.get('explanation').trim();
    
    if (!stem) {
      alert('Please enter a question stem');
      return;
    }
    
    const choices = [];
    document.querySelectorAll('.composer-choice').forEach((input, idx) => {
      const text = input.value.trim();
      if (text) {
        const correctCheckbox = document.querySelector(`.composer-correct[data-idx="${input.dataset.idx}"]`);
        choices.push({
          id: String.fromCharCode(97 + idx),
          text: text,
          correct: correctCheckbox ? correctCheckbox.checked : false
        });
      }
    });
    
    if (choices.length < 2) {
      alert('Please add at least 2 answer choices');
      return;
    }
    
    const correctCount = choices.filter(ch => ch.correct).length;
    if (correctCount === 0) {
      alert('Please mark at least one correct answer');
      return;
    }
    
    // Add to current MCQs
    if (!window.currentMCQs) window.currentMCQs = { questions: [] };
    if (!window.currentMCQs.questions) window.currentMCQs.questions = [];
    
    window.currentMCQs.questions.push({
      stem: stem,
      multi_select: correctCount > 1,
      choices: choices,
      explanation: explanation
    });
    
    renderMCQEditor(window.currentMCQs);
    composerModal.remove();
    alert('Question added!');
  };
}

/* ---------- Generate MCQs with LLM ---------- */
async function generateMCQs(caseData, numQuestions = 5) {
  const btn = numQuestions === 1 ? 
    document.getElementById('generateOneMCQBtn') : 
    document.getElementById('generateMCQBtn');
  
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Generating...';
  }
  
  try {
    const token = localStorage.getItem('jwt');
    const response = await fetch(`${CONFIG.API_BASE}/api/cases/${caseData.id}/generate-mcqs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: caseData.title,
        boardPrompt: caseData.boardPrompt,
        expectedAnswer: caseData.expectedAnswer,
        subspecialty: caseData.subspecialty,
        numQuestions: numQuestions
      })
    });
    
    if (!response.ok) {
      throw new Error(`Failed to generate MCQs: ${response.status}`);
    }
    
    const generated = await response.json();
    const newMCQs = generated.mcqs || generated;
    
    // APPEND new questions to existing ones (don't replace)
    if (!window.currentMCQs) window.currentMCQs = { questions: [] };
    if (!window.currentMCQs.questions) window.currentMCQs.questions = [];
    
    if (newMCQs && newMCQs.questions) {
      window.currentMCQs.questions.push(...newMCQs.questions);
    }
    
    renderMCQEditor(window.currentMCQs);
    
    alert(`Generated ${numQuestions === 1 ? '1 question' : newMCQs.questions.length + ' questions'}! Review and edit before saving.`);
  } catch (error) {
    console.error('MCQ generation failed:', error);
    alert(`Failed to generate MCQs: ${error.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = numQuestions === 1 ? '✨ Generate 1 MCQ' : '✨ Generate 3-5 MCQs';
    }
  }
}

/* ---------- Save Edited Case ---------- */
async function saveEditedCase(caseId, form) {
  const formData = new FormData(form);
  
  // Collect MCQ and Rubric data from editors
  const mcqs = collectMCQData();
  const rubric = collectRubricData();
  
  const payload = {
    title: formData.get('title'),
    subspecialty: formData.get('subspecialty'),
    boardPrompt: formData.get('boardPrompt'),
    expectedAnswer: formData.get('expectedAnswer'),
    rubric: rubric,
    tags: formData.get('tags').split(',').map(s => s.trim()).filter(Boolean),
    // images: formData.get('images').split('\n').map(s => s.trim()).filter(Boolean),
    images: formData.get('images').split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .map(url => url.split('?')[0]), // Strip tokens before saving
    mcqs: mcqs.questions.length > 0 ? mcqs : null
  };
  
  try {
    const token = localStorage.getItem('jwt');
    const response = await fetch(`${CONFIG.API_BASE}/api/cases/${caseId}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`Failed to update: ${response.status}`);
    }
    
    alert('Case updated successfully!');
    
    // Reload cases to refresh thumbnails and data
    await loadCasesFromDatabase();
    
  } catch (error) {
    console.error('Update failed:', error);
    alert(`Failed to update case: ${error.message}`);
  }
}

/* ---------- Collect MCQ Data from Editor ---------- */
function collectMCQData() {
  const questions = [];
  
  document.querySelectorAll('.mcq-stem').forEach((stemEl, qIdx) => {
    const stem = stemEl.value.trim();
    if (!stem) return;
    
    const choices = [];
    document.querySelectorAll(`.mcq-choice-text[data-qidx="${qIdx}"]`).forEach((choiceEl, chIdx) => {
      const text = choiceEl.value.trim();
      if (!text) return;
      
      const correctEl = document.querySelector(`.mcq-correct[data-qidx="${qIdx}"][data-chidx="${chIdx}"]`);
      const correct = correctEl ? correctEl.checked : false;
      
      choices.push({
        id: String.fromCharCode(97 + chIdx),
        text,
        correct
      });
    });
    
    const explanationEl = document.querySelector(`.mcq-explanation[data-idx="${qIdx}"]`);
    const explanation = explanationEl ? explanationEl.value.trim() : '';
    
    const correctCount = choices.filter(ch => ch.correct).length;
    
    questions.push({
      stem,
      multi_select: correctCount > 1,
      choices,
      explanation
    });
  });
  
  return { questions };
}

/* ---------- Open Trash Modal ---------- */
async function openTrashModal() {
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.style.display = 'block';
  
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-inner" style="max-width:1000px; max-height:90vh; overflow-y:auto;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
        <h3 style="margin:0;">🗑️ Trash (Deleted Cases)</h3>
        <div style="display:flex; gap:8px;">
          <button class="btn ghost" id="emptyTrashBtn" style="color:#EF5350;">Empty Trash</button>
          <button class="btn ghost" id="closeTrashModal">Close</button>
        </div>
      </div>
      
      <div id="trashList" style="display:grid; gap:12px;">
        <div class="small" style="text-align:center; padding:40px; color:#999;">
          Loading deleted cases...
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  document.getElementById('closeTrashModal').onclick = () => modal.remove();
  document.getElementById('emptyTrashBtn').onclick = emptyTrash;
  modal.querySelector('.modal-backdrop').onclick = () => modal.remove();
  
  await loadTrash();
}

/* ---------- Load Deleted Cases ---------- */
async function loadTrash() {
  try {
    const token = localStorage.getItem('jwt');
    const response = await fetch(`${CONFIG.API_BASE}/api/cases/trash`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to load trash: ${response.status}`);
    }
    
    const deletedCases = await response.json();
    renderTrash(deletedCases);
  } catch (error) {
    console.error('Failed to load trash:', error);
    document.getElementById('trashList').innerHTML = `
      <div class="small" style="text-align:center; padding:40px; color:#EF5350;">
        Failed to load trash: ${error.message}
      </div>
    `;
  }
}

/* ---------- Render Trash ---------- */
function renderTrash(cases) {
  const trashList = document.getElementById('trashList');
  
  if (!cases.length) {
    trashList.innerHTML = `
      <div class="small" style="text-align:center; padding:40px; color:#999;">
        Trash is empty
      </div>
    `;
    return;
  }
  
  trashList.innerHTML = cases.map(c => `
    <div class="box" style="display:flex; gap:12px; align-items:center;">
      <img src="${getThumbSrc(c)}" 
           style="width:80px; height:80px; object-fit:cover; border-radius:4px; flex-shrink:0;"
           onerror="this.style.display='none'">
      
      <div style="flex:1; min-width:0;">
        <div style="font-weight:500; margin-bottom:4px;">${escapeHtml(c.title)}</div>
        <div class="small" style="color:#666; margin-bottom:4px;">
          <span class="pill">${c.subspecialty}</span>
        </div>
        <div class="small" style="color:#999;">
          Deleted ${formatDeletedDate(c.deletedAt)} by ${c.deletedBy || 'unknown'}
        </div>
      </div>
      
      <div style="display:flex; gap:8px; flex-shrink:0;">
        <button class="btn ghost" onclick="restoreCase('${c.id}')" style="background:#4CAF50; color:white;">
          ↺ Restore
        </button>
        <button class="btn ghost" onclick="permanentlyDeleteCase('${c.id}')" style="background:#EF5350; color:white;">
          ✕ Delete Forever
        </button>
      </div>
    </div>
  `).join('');
}

/* ---------- Restore Case ---------- */
window.restoreCase = async function(caseId) {
  if (!confirm('Restore this case?')) return;
  
  try {
    const token = localStorage.getItem('jwt');
    const response = await fetch(`${CONFIG.API_BASE}/api/cases/${caseId}/restore`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to restore: ${response.status}`);
    }
    
    alert('Case restored successfully!');
    await loadTrash();
    await loadCasesFromDatabase();
  } catch (error) {
    console.error('Restore failed:', error);
    alert(`Failed to restore case: ${error.message}`);
  }
}

/* ---------- Permanently Delete Case ---------- */
window.permanentlyDeleteCase = async function(caseId) {
  if (!confirm('⚠️ PERMANENTLY DELETE this case? This CANNOT be undone!')) return;
  if (!confirm('Are you absolutely sure? This will delete it forever!')) return;
  
  try {
    const token = localStorage.getItem('jwt');
    const response = await fetch(`${CONFIG.API_BASE}/api/cases/${caseId}/permanent`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to delete: ${response.status}`);
    }
    
    alert('Case permanently deleted');
    await loadTrash();
  } catch (error) {
    console.error('Permanent delete failed:', error);
    alert(`Failed to delete case: ${error.message}`);
  }
}

/* ---------- Empty Trash ---------- */
async function emptyTrash() {
  if (!confirm('⚠️ PERMANENTLY DELETE ALL items in trash? This CANNOT be undone!')) return;
  if (!confirm('Are you absolutely sure? This will delete everything in trash forever!')) return;
  
  try {
    const token = localStorage.getItem('jwt');
    
    const response = await fetch(`${CONFIG.API_BASE}/api/cases/trash`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!response.ok) {
      throw new Error('Failed to load trash');
    }
    
    const deletedCases = await response.json();
    
    const deletePromises = deletedCases.map(c =>
      fetch(`${CONFIG.API_BASE}/api/cases/${c.id}/permanent`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
    );
    
    await Promise.all(deletePromises);
    
    alert(`Permanently deleted ${deletedCases.length} case(s)`);
    await loadTrash();
  } catch (error) {
    console.error('Empty trash failed:', error);
    alert(`Failed to empty trash: ${error.message}`);
  }
}

/* ---------- Helper: Format Deleted Date ---------- */
function formatDeletedDate(isoString) {
  if (!isoString) return 'unknown';
  
  try {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
  } catch {
    return 'unknown';
  }
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
    if(!c) return alert('No cases loaded.');
    window.openViewer(c);
  };
  document.getElementById('randomSet').onclick=()=>{
    const list = getFiltered();
    if(!list.length) return alert('No cases loaded.');
    const n = Math.min(5, list.length);
    alert("Random set:\n\n" + shuffle([...list]).slice(0,n).map(c=>`• ${c.title} — ${c.subspecialty}`).join('\n'));
  };

  document.getElementById('vMicBtn')?.addEventListener('click', toggleMic);

  document.getElementById('gradeBtn')?.addEventListener('click', async ()=>{
    const transcriptEl = document.getElementById('vTranscript');
    const tr = transcriptEl ? transcriptEl.value.trim() : '';
  
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
      letter: letter(heur),
      type: 'oral'
    });
    updateCounts();
    
    // Show feedback section after grading
    const feedbackSection = document.getElementById('feedbackSection');
    if (feedbackSection) feedbackSection.style.display = 'block';
  });

  // Bridge to viewer
  window.openViewer = async (c)=>{
    console.log('Opening case:', c.id);
    
    let caseToOpen = c;
    if (c.images && c.images.length > 0 && c.images[0].includes('s3.amazonaws.com')) {
      try {
        const token = localStorage.getItem('jwt');
        console.log('🔍 Fetching signed URLs for viewer...');
        
        const response = await fetch(`${CONFIG.API_BASE}/api/cases/${c.id}/signed`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        console.log('📡 Response status:', response.status, response.statusText);
        console.log('📡 Content-Type:', response.headers.get('content-type'));
        
        if (response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            caseToOpen = await response.json();
            console.log('✅ Loaded case with signed URLs:', caseToOpen.images?.[0]?.substring(0, 100) + '...');
          } else {
            const text = await response.text();
            console.error('❌ Non-JSON response from signed endpoint:', text.substring(0, 500));
            console.error('❌ Full response length:', text.length);
          }
        } else {
          const errorText = await response.text();
          console.error('❌ Signed URL request failed:', response.status, errorText.substring(0, 500));
        }
      } catch (error) {
        console.error('Failed to load signed URLs:', error);
        console.error('Error type:', error.constructor.name);
        console.error('Error message:', error.message);
      }
    }
    
    window.__currentCaseForGrading = caseToOpen;
    openViewerBase(caseToOpen);

    // Set up show/hide answer button
    setupShowAnswerButton(caseToOpen);

    if (mode === 'mcq' && !(caseToOpen?.mcqs?.questions?.length)) {
      mode = 'oral';
      localStorage.setItem('mode', mode);
    }

    setToggleChecked(mode === 'mcq');
    renderMode();
    if (mode === 'mcq') renderMCQs(caseToOpen); else clearMCQs();
    
    // Hide feedback section initially
    const feedbackSection = document.getElementById('feedbackSection');
    if (feedbackSection) feedbackSection.style.display = 'none';
  };

  bindLLMChatUI();
  bindModeToggle();
  renderMode();
  render();
  
  // Fetch user info and set up admin UI
  fetchCurrentUser().then(() => {
    updateAdminUI();
    
    // Add toggle admin mode button and trash button for admins
    if (isAdmin()) {
      const toolbar = document.querySelector('.toolbar') || document.querySelector('header') || document.body;
      
      // Add edit mode toggle
      const toggleBtn = document.createElement('button');
      toggleBtn.id = 'toggleAdminMode';
      toggleBtn.className = 'btn ghost';
      toggleBtn.textContent = 'Edit Cases';
      toggleBtn.onclick = toggleAdminMode;
      toolbar.appendChild(toggleBtn);
      
      // Add trash button
      const trashBtn = document.createElement('button');
      trashBtn.id = 'viewTrashBtn';
      trashBtn.className = 'btn ghost';
      trashBtn.textContent = '🗑️ Trash';
      trashBtn.onclick = openTrashModal;
      toolbar.appendChild(trashBtn);
    }
  });
  
  // Set up LLM chat
  setupLLMChat();
  
  // Load cases from database
  loadCasesFromDatabase();
}

/* ---------- Render grid ---------- */
function render(){
  updateCounts();

  const list = getFiltered();
  
  // Show bulk actions if in admin mode
  if (isAdminMode && isAdmin()) {
    grid.innerHTML = `
      <div class="admin-bulk-actions" style="margin-bottom:16px; padding:12px; background:#1a1a1f; border:1px solid #2a2a2f; border-radius:8px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <button class="btn ghost" id="selectAllBtn">Select All</button>
          <button class="btn ghost" id="deselectAllBtn">Deselect All</button>
          <span style="margin-left:auto; color:#888;">${selectedCases.size} selected</span>
          <button class="btn" id="bulkDeleteBtn" style="background:#EF5350; ${selectedCases.size === 0 ? 'opacity:0.5; pointer-events:none;' : ''}">
            Delete Selected (${selectedCases.size})
          </button>
        </div>
      </div>
    `;
    
    document.getElementById('selectAllBtn')?.addEventListener('click', () => {
      list.forEach(c => selectedCases.add(c.id));
      render();
    });
    
    document.getElementById('deselectAllBtn')?.addEventListener('click', () => {
      selectedCases.clear();
      render();
    });
    
    document.getElementById('bulkDeleteBtn')?.addEventListener('click', () => {
      bulkDeleteCases();
    });
  } else {
    grid.innerHTML = '';
  }
  
  if (!list.length) {
    grid.innerHTML += `<div class="small">No cases match your filters.</div>`;
    return;
  }

  list.forEach(c=>{
    const card = document.createElement('div');
    card.className = 'card';
    
    // Add checkbox for admin mode
    if (isAdminMode && isAdmin()) {
      card.style.position = 'relative';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedCases.has(c.id);
      checkbox.style.cssText = 'position:absolute; top:8px; left:8px; width:20px; height:20px; cursor:pointer; z-index:10;';
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        if (e.target.checked) {
          selectedCases.add(c.id);
        } else {
          selectedCases.delete(c.id);
        }
        render();
      });
      card.appendChild(checkbox);
    }

    const th = document.createElement('div'); 
    th.className='thumb';
    const img = document.createElement('img'); 
    img.loading='lazy'; 
    img.src = getThumbSrc(c) || ''; 
    th.appendChild(img);

    const title = document.createElement('div'); 
    title.textContent = c.title;

    const meta = document.createElement('div'); 
    meta.className='meta';
    const sub = document.createElement('span'); 
    sub.className='pill'; 
    sub.textContent = c.subspecialty;

    const actions = document.createElement('div'); 
    actions.style.display='flex'; 
    actions.style.gap='8px';
    actions.style.flexWrap='wrap';
    
    const choose = document.createElement('button'); 
    choose.className='btn ghost'; 
    choose.textContent='Choose';
    choose.onclick=()=>window.openViewer(c);
    
    const random = document.createElement('button'); 
    random.className='btn'; 
    random.textContent='Random similar';
    random.onclick=()=> {
      const pool = getAll().filter(x=>x.subspecialty===c.subspecialty);
      window.openViewer(randomPick(pool) || c);
    };

    actions.appendChild(choose);
    actions.appendChild(random);
    
    // Add admin buttons
    if (isAdmin()) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn ghost';
      editBtn.textContent = 'Edit';
      editBtn.style.background = '#2196F3';
      editBtn.style.color = 'white';
      editBtn.onclick = (e) => {
        e.stopPropagation();
        openEditCaseModal(c);
      };
      
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn ghost';
      deleteBtn.textContent = 'Delete';
      deleteBtn.style.background = '#EF5350';
      deleteBtn.style.color = 'white';
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        deleteCase(c.id);
      };
      
      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
    }
    
    meta.appendChild(sub); 
    meta.appendChild(actions);

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
  
  const score = nCorrect / cards.length;
  const percentage = Math.round(score * 100);
  scoreLine.textContent = `Score: ${nCorrect} / ${cards.length} (${percentage}%)`;
  
  // Auto-save the score
  recordAttempt({
    caseId: caseObj.id,
    subspecialty: caseObj.subspecialty || 'Unknown',
    similarity: score,
    rubricHit: nCorrect,
    rubricTotal: cards.length,
    letter: score >= 0.75 ? 'A' : score >= 0.60 ? 'B' : score >= 0.50 ? 'C' : 'F',
    type: 'mcq'
  });
  updateCounts();
  console.log('✓ MCQ score saved');
}

/* ---------- LLM Chat ---------- */
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