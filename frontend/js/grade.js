/* grade.js — domain-aware heuristic + LLM payload builder */
import { CONFIG } from './config.js';

export async function gradeWithLLM({caseObj, transcript, heur}) {
  const payload = buildLLMPayload({caseObj, transcript, heur});
  const res = await fetch(CONFIG.FEEDBACK_API, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('LLM API error');
  return await res.json(); // expect { feedback, score? }
}

export function buildLLMPayload({caseObj, transcript, heur}){
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
4) Give a 2-3 sentence coaching paragraph on how to improve.
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

/* ---------- Text utils ---------- */
const STOP = new Set(("a an the of and or to in on with without for at by from into over under about above below between across as is are was were be being been this that these those there here it its it's your you we they he she his her their our").split(/\s+/));

function tokenize(t){
  return (t||"").toLowerCase()
    .replace(/[^a-z0-9\s->]/g,' ')     // keep > for ">6 mm"
    .split(/\s+/)
    .filter(w=>w && !STOP.has(w));
}
function bigrams(tokens){ const out=[]; for(let i=0;i<tokens.length-1;i++) out.push(tokens[i]+' '+tokens[i+1]); return out; }
function clamp01(x){ return x<0?0:(x>1?1:x); }
function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ---------- Domain-aware phrase matching ---------- */
/* Build robust regex that matches word boundaries and simple variants */
function mkPhraseRe(p){
  // allow plural(s) and small variations like "consult/consultation"
  const alt = p
    .replace(/\bconsultation\b/gi, '(?:consultation|consult)')
    .replace(/\bconsult\b/gi, '(?:consult|consultation)')
    .replace(/\bantibiotics?\b/gi, 'antibiotic(?:s)?')
    .replace(/\bappendices\b/gi, 'appendic(?:e|e|i)s')
    .replace(/\bmm\b/gi, 'mm')
    .replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${alt}\\b`, 'i');
}
function hasAny(text, phrases){
  for(const p of phrases){
    const re = PHRASE_RE_CACHE.get(p) || mkPhraseRe(escRe(p));
    PHRASE_RE_CACHE.set(p, re);
    if(re.test(text)) return true;
  }
  return false;
}
const PHRASE_RE_CACHE = new Map();

/* Rubric classifiers: map rubric lines to detection rules */
function classifyRubric(item){
  const s = (item||'').toLowerCase();
  if (s.includes('appendicitis')) return 'dx_appendicitis';
  if (s.includes('enlarged appendix') || s.includes('>6 mm') || s.includes('> 6 mm') || s.includes('>6mm')) return 'appendix_size';
  if (s.includes('stranding')) return 'fat_stranding';
  if (s.includes('appendicolith') || s.includes('fecalith') || s.includes('coprolith')) return 'appendicolith';
  if (s.includes('complication') || s.includes('perforation') || s.includes('abscess') || s.includes('extraluminal')) return 'complications';
  if (s.includes('surgery') || s.includes('antibiotic') || s.includes('management') || s.includes('consult')) return 'management_surgery_abx';
  return null;
}

/* Detection rules per class */
const RULES = {
  dx_appendicitis: (t)=> hasAny(t, [
    'appendicitis', 'acute appendicitis'
  ]),
  appendix_size: (t)=> hasAny(t, [
    'enlarged appendix', 'dilated appendix', 'noncompressible appendix',
    '>6 mm', '> 6 mm', 'greater than 6 mm', 'increased caliber'
  ]),
  fat_stranding: (t)=> hasAny(t, [
    'periappendiceal stranding', 'fat stranding', 'inflammatory stranding', 'rlq stranding', 'peri-appendiceal stranding'
  ]),
  appendicolith: (t)=> hasAny(t, [
    'appendicolith', 'fecalith', 'coprolith', 'appendiceal stone'
  ]),
  complications: (t)=> hasAny(t, [
    'perforation', 'perforated', 'extraluminal air', 'free air',
    'abscess', 'phlegmon', 'fluid collection', 'drainable abscess'
  ]),
  management_surgery_abx: (t)=> hasAny(t, [
    'surgical consult', 'surgical consultation', 'surgery', 'appendectomy',
    'antibiotic', 'antibiotics'
  ])
};

/* Generic fallback match for rubric items that don't classify */
function fuzzyContains(text, phrase){
  const toks = tokenize(phrase);
  if(!toks.length) return false;
  let found=0;
  for(const t of toks){ if(text.includes(t)) found++; }
  // lower threshold to 50% and accept near-synonyms via stems
  return (found / toks.length) >= 0.5;
}

/* ---------- Heuristic grading ---------- */
export function gradeHeuristic({transcript, promptTxt, expected, rubric}){
  const tPlain = (transcript||'').toLowerCase();

  // token/bigram overlap (still used, but less dominant)
  const tt = tokenize(transcript);
  const pt = tokenize(promptTxt);
  const et = tokenize(expected);
  const tb = bigrams(tt), pb=bigrams(pt), eb=bigrams(et);

  const uniCase = new Set([...pt, ...et]);
  const biCase = new Set([...pb, ...eb]);
  const uniHit = tt.filter(w=>uniCase.has(w)).length;
  const biHit = tb.filter(b=>biCase.has(b)).length;
  const uniDen = Math.max(uniCase.size,1);
  const biDen = Math.max(biCase.size,1);
  const uniSim = uniHit/uniDen;
  const biSim  = biHit/biDen;

  // rubric coverage with domain-aware rules
  const hits = [];
  const misses = [];
  for(const item of rubric||[]){
    const cls = classifyRubric(item);
    let ok = false;
    if (cls && RULES[cls]) ok = RULES[cls](tPlain);
    else ok = fuzzyContains(tPlain, (item||'').toLowerCase());
    (ok?hits:misses).push(item);
  }
  const rubricFrac = (rubric && rubric.length) ? (hits.length / rubric.length) : 0;

  // blended similarity: token/bigram + rubric coverage
  const sim = clamp01(0.4*uniSim + 0.3*biSim + 0.3*rubricFrac);

  return {
    similarity: sim,
    rubricHit: hits.length,
    rubricMiss: (rubric?.length||0) - hits.length,
    hits, misses,
    details: {uniHit,uniDen,biHit,biDen, rubricFrac}
  };
}

export function heuristicFeedback(h){
  let lines = [];
  lines.push(`Similarity to case focus: ${Math.round(h.similarity*100)}%`);
  lines.push(`Rubric coverage: ${h.rubricHit} hit(s), ${h.rubricMiss} missing`);
  if(h.hits.length) lines.push(`✔ Covered: ${h.hits.join('; ')}`);
  if(h.misses.length) lines.push(`✖ Missing/unclear: ${h.misses.join('; ')}`);
  lines.push('');
  lines.push('Tip: Lead with the diagnosis, cite 2–3 key imaging findings, and state concrete management.');
  return lines.join('\n');
}

export function letter(h){
  const r = h.rubricHit, total = h.rubricHit + h.rubricMiss;
  const frac = total ? r/total : 0;
  const s = h.similarity;
  // friendlier cutoffs now that rubric coverage is baked into similarity
  if(frac>=0.8 || s>0.75) return 'A';
  if(frac>=0.66 || s>0.65) return 'B';
  if(frac>=0.5  || s>0.55) return 'C';
  if(frac>=0.33 || s>0.45) return 'D';
  return 'F';
}
