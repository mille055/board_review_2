// frontend/js/grade.js
import { CONFIG } from './config.js';

/* ========== LLM payload builder ========== */
export function buildLLMPayload({ caseObj, transcript, heur }) {
  return {
    caseId: caseObj.id,
    title: caseObj.title,
    subspecialty: caseObj.subspecialty,
    boardPrompt: caseObj.boardPrompt,
    expectedAnswer: caseObj.expectedAnswer,
    rubric: caseObj.rubric || [],
    transcript,
    heuristic: heur,
    llmInstruction: `
You are an expert radiology oral-boards examiner.
Evaluate the trainee's transcript for this case.
1) Provide a concise summary of what they got right.
2) List specific gaps or incorrect statements.
3) Map their response to the rubric items (hit/miss) with one-line rationale each.
4) Give a 2–3 sentence coaching paragraph on how to improve.
Keep tone supportive, precise, and clinically grounded. Avoid hallucinations.
If the transcript is off-topic, say so and redirect to key imaging findings and next steps.`,
    llmInputs: {
      case_summary: caseObj.boardPrompt,
      expected_answer: caseObj.expectedAnswer,
      rubric: caseObj.rubric || [],
      trainee_transcript: transcript
    }
  };
}

/* ========== Text utils ========== */
const STOP = new Set(("a an the of and or to in on with without for at by from into over under about above below between across as is are was were be being been this that these those there here it its it's your you we they he she his her their our").split(/\s+/));

function tokenize(t) {
  return (t || "").toLowerCase()
    .replace(/[^a-z0-9\s->]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOP.has(w));
}
function bigrams(tokens) { const out = []; for (let i = 0; i < tokens.length - 1; i++) out.push(tokens[i] + ' ' + tokens[i + 1]); return out; }
function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ========== Domain-aware phrase matching ========== */
const PHRASE_RE_CACHE = new Map();
function mkPhraseRe(p) {
  const alt = p
    .replace(/\bconsultation\b/gi, '(?:consultation|consult)')
    .replace(/\bconsult\b/gi, '(?:consult|consultation)')
    .replace(/\bantibiotics?\b/gi, 'antibiotic(?:s)?')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${alt}\\b`, 'i');
}
function hasAny(text, phrases) {
  for (const p of phrases) {
    const re = PHRASE_RE_CACHE.get(p) || mkPhraseRe(escRe(p));
    PHRASE_RE_CACHE.set(p, re);
    if (re.test(text)) return true;
  }
  return false;
}

/* Map rubric lines to detection classes */
function classifyRubric(item) {
  const s = (item || '').toLowerCase();
  if (s.includes('appendicitis')) return 'dx_appendicitis';
  if (s.includes('enlarged appendix') || s.includes('>6') || s.includes('> 6') || s.includes('>6mm')) return 'appendix_size';
  if (s.includes('stranding')) return 'fat_stranding';
  if (s.includes('appendicolith') || s.includes('fecalith') || s.includes('coprolith')) return 'appendicolith';
  if (s.includes('complication') || s.includes('perforation') || s.includes('abscess') || s.includes('extraluminal')) return 'complications';
  if (s.includes('surgery') || s.includes('antibiotic') || s.includes('management') || s.includes('consult')) return 'management_surgery_abx';
  return null;
}

/* Detection rules */
const RULES = {
  dx_appendicitis: (t) => hasAny(t, [
    'appendicitis', 'acute appendicitis'
  ]),
  appendix_size: (t) => hasAny(t, [
    'enlarged appendix', 'dilated appendix', 'noncompressible appendix',
    '>6 mm', '> 6 mm', 'greater than 6 mm', 'increased caliber'
  ]),
  fat_stranding: (t) => hasAny(t, [
    'periappendiceal stranding', 'fat stranding', 'inflammatory stranding', 'rlq stranding', 'peri-appendiceal stranding'
  ]),
  appendicolith: (t) => hasAny(t, [
    'appendicolith', 'fecalith', 'coprolith', 'appendiceal stone'
  ]),
  complications: (t) => hasAny(t, [
    'perforation', 'perforated', 'extraluminal air', 'free air',
    'abscess', 'phlegmon', 'fluid collection', 'drainable abscess'
  ]),
  management_surgery_abx: (t) => hasAny(t, [
    'surgical consult', 'surgical consultation', 'surgery', 'appendectomy',
    'antibiotic', 'antibiotics'
  ])
};

/* Fallback fuzzy match for unknown rubric items */
function fuzzyContains(text, phrase) {
  const toks = tokenize(phrase);
  if (!toks.length) return false;
  let found = 0;
  for (const t of toks) if (text.includes(t)) found++;
  return (found / toks.length) >= 0.5;
}

/* ========== Heuristic grading ========== */
export function gradeHeuristic({ transcript, promptTxt, expected, rubric }) {
  const tPlain = (transcript || '').toLowerCase();

  const tt = tokenize(transcript);
  const pt = tokenize(promptTxt);
  const et = tokenize(expected);
  const tb = bigrams(tt), pb = bigrams(pt), eb = bigrams(et);

  const uniCase = new Set([...pt, ...et]);
  const biCase = new Set([...pb, ...eb]);
  const uniHit = tt.filter(w => uniCase.has(w)).length;
  const biHit = tb.filter(b => biCase.has(b)).length;
  const uniDen = Math.max(uniCase.size, 1);
  const biDen = Math.max(biCase.size, 1);
  const uniSim = uniHit / uniDen;
  const biSim = biHit / biDen;

  const hits = [];
  const misses = [];
  for (const item of rubric || []) {
    const cls = classifyRubric(item);
    let ok = false;
    if (cls && RULES[cls]) ok = RULES[cls](tPlain);
    else ok = fuzzyContains(tPlain, (item || '').toLowerCase());
    (ok ? hits : misses).push(item);
  }
  const rubricFrac = (rubric && rubric.length) ? (hits.length / rubric.length) : 0;

  const sim = clamp01(0.4 * uniSim + 0.3 * biSim + 0.3 * rubricFrac);

  return {
    similarity: sim,
    rubricHit: hits.length,
    rubricMiss: (rubric?.length || 0) - hits.length,
    hits, misses,
    details: { uniHit, uniDen, biHit, biDen, rubricFrac }
  };
}

export function heuristicFeedback(h) {
  const lines = [];
  lines.push(`Similarity to case focus: ${Math.round(h.similarity * 100)}%`);
  lines.push(`Rubric coverage: ${h.rubricHit} hit(s), ${h.rubricMiss} missing`);
  if (h.hits.length) lines.push(`✔ Covered: ${h.hits.join('; ')}`);
  if (h.misses.length) lines.push(`✖ Missing/unclear: ${h.misses.join('; ')}`);
  lines.push('');
  lines.push('Tip: Lead with the diagnosis, cite 2–3 key imaging findings, and state concrete management.');
  return lines.join('\n');
}

export function letter(h) {
  const r = h.rubricHit, total = h.rubricHit + h.rubricMiss;
  const frac = total ? r / total : 0;
  const s = h.similarity;
  if (frac >= 0.8 || s > 0.75) return 'A';
  if (frac >= 0.66 || s > 0.65) return 'B';
  if (frac >= 0.5 || s > 0.55) return 'C';
  if (frac >= 0.33 || s > 0.45) return 'D';
  return 'F';
}

/* ========== LLM caller (hybrid mode) ========== */
export async function gradeWithLLM({ caseObj, transcript, heur }) {
  const payload = buildLLMPayload({ caseObj, transcript, heur });

  // If FEEDBACK_MODE isn't hybrid/llm, short-circuit
  if (!CONFIG || (CONFIG.FEEDBACK_MODE === 'heuristic')) {
    console.debug('[LLM] skipped, FEEDBACK_MODE=heuristic');
    return { feedback: '(LLM disabled: FEEDBACK_MODE=heuristic)', score: heur };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.API_KEY) {
    headers['x-api-key'] = CONFIG.API_KEY;
  }

  const token = localStorage.getItem('jwt');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  console.debug('[LLM] POST', CONFIG.FEEDBACK_API, 'hdrs=', Object.keys(headers));

  // if (!token) {
  //   return { feedback: 'Login required for LLM feedback (no JWT found).', score: heur };
  // }

  let res;
  try {
    res = await fetch(CONFIG.FEEDBACK_API, {
      method: 'POST',
      //headers: {'Content-Type':'application/json','Authorization':`Bearer ${token}`},
      headers,
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('[LLM] network error', e);
    return { feedback: `LLM network error: ${e}`, score: heur };
  }

  console.debug('[LLM] status', res.status);
  if (!res.ok) {
    const txt = await res.text().catch(()=>'');
    console.warn('[LLM] non-200', res.status, txt);
    let msg = `LLM API error ${res.status}`;
    if (res.status === 401) msg += ' (unauthorized; check API key or login)';
    else if (res.status === 403) msg += ' (forbidden; check API key or permissions)';
    else if (res.status === 429) msg += ' (rate limit exceeded)';
    else if (res.status >= 500) msg += ' (server error; try again later)';
    else if (txt) msg += `: ${txt}`;
    return { feedback: `LLM API error ${msg}: ${txt}`, score: heur };
  }
  const data = await res.json();
  console.debug('[LLM] ok; bytes=', JSON.stringify(data).length);
  return data;
}
