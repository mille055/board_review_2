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
    llmInstruction: `
You are an expert radiology oral-boards examiner. Evaluate the trainee's response against the rubric.

CRITICAL GRADING RULES - BE VERY GENEROUS:

1. **Contextual equivalence**: If the concept is mentioned, even with different wording or without anatomic qualifiers, COUNT IT AS A HIT
   
   Examples:
   - "stranding" in appendicitis = "periappendiceal stranding" ✓
   - "fluid" near appendix = "periappendiceal fluid" ✓
   - "echogenicity of cortex is normal" = "cortical sparing" ✓
   - "no cortical involvement" = "cortical sparing" ✓
   - "hyperemia" in scrotal US = "hyperemia of epididymis" ✓

2. **Synonyms and paraphrases**: Recognize equivalent medical terminology
   - "heterogeneity" = "heterogeneous echotexture" = "varied appearance" ✓
   - "complicated fluid" = "complex fluid" = "septated collection" ✓
   - "enlargement" = "enlarged" = "increased size" = "dilated" ✓
   - "no perforation" = "no free air" = "no abscess" (when addressing complications) ✓

3. **Implicit information**: If they describe something that implies the rubric item, COUNT IT
   - Describing normal cortex while abnormal medulla implies cortical sparing ✓
   - Mentioning findings in proper anatomic context counts even without explicit anatomic qualifier ✓
   - "I would compare to the other side" = mentions contralateral comparison ✓

4. **Focus on knowledge demonstrated, not exact wording**: 
   - Did they show they understand the finding? → HIT
   - Did they use slightly different terminology? → Still a HIT
   - Did they describe the concept without naming it? → Still a HIT

5. **Do NOT penalize for**:
   - Missing anatomic qualifiers when obvious from context
   - Using synonyms or paraphrases
   - Describing a finding instead of naming it
   - Slightly different word order or phrasing

6. **Only mark as MISS if**:
   - They truly didn't mention or describe the concept at all
   - They got it wrong (not just worded differently)
   - The concept is completely absent from their response

REQUIRED OUTPUT FORMAT:
Provide a JSON response with:
{
  "rubricHit": <number of rubric items covered>,
  "rubricMiss": <number of rubric items missed>,
  "similarity": <0.0 to 1.0 score - be generous, 0.7+ for good answers>,
  "hits": [<list of covered rubric items>],
  "misses": [<list of missed rubric items>],
  "feedback": "<detailed paragraph with: 1) what they did well, 2) specific gaps if any, 3) encouragement>"
}

Remember: This is oral boards training. The goal is to help them learn, not to be pedantic about exact wording. If they demonstrated the knowledge, give them credit.`,
    llmInputs: {
      case_summary: caseObj.boardPrompt,
      expected_answer: caseObj.expectedAnswer,
      rubric: caseObj.rubric || [],
      trainee_transcript: transcript
    }
  };
}

/* ========== Simple heuristic (for quick initial feedback only) ========== */
export function gradeHeuristic({ transcript, promptTxt, expected, rubric }) {
  const tLower = (transcript || '').toLowerCase();
  
  // Very simple keyword check - just for initial quick feedback
  const hits = [];
  const misses = [];
  
  for (const item of rubric || []) {
    const keywords = item.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const matchCount = keywords.filter(kw => tLower.includes(kw)).length;
    
    // If at least 30% of keywords found, consider it a potential hit (lowered from 40%)
    if (matchCount / keywords.length >= 0.3) {
      hits.push(item);
    } else {
      misses.push(item);
    }
  }
  
  const rubricFrac = (rubric && rubric.length) ? (hits.length / rubric.length) : 0;
  
  // Simple estimate - LLM will provide the real score
  const similarity = rubricFrac * 0.8; // Conservative estimate

  return {
    similarity,
    rubricHit: hits.length,
    rubricMiss: (rubric?.length || 0) - hits.length,
    hits, 
    misses,
    isHeuristic: true // Flag that this is just an estimate
  };
}

export function heuristicFeedback(h) {
  const lines = [];
  lines.push(`Initial estimate: ${Math.round(h.similarity * 100)}%`);
  lines.push(`Rubric coverage: ${h.rubricHit} likely hit(s), ${h.rubricMiss} possibly missing`);
  if (h.hits.length) lines.push(`✔ Likely covered: ${h.hits.join('; ')}`);
  if (h.misses.length) lines.push(`⚠ Possibly missing: ${h.misses.join('; ')}`);
  lines.push('');
  lines.push('⏳ Waiting for detailed LLM feedback...');
  return lines.join('\n');
}

export function letter(h) {
  const r = h.rubricHit, total = h.rubricHit + h.rubricMiss;
  const frac = total ? r / total : 0;
  const s = h.similarity;
  
  // Generous thresholds
  if (frac >= 0.8 || s >= 0.80) return 'A';
  if (frac >= 0.7 || s >= 0.70) return 'B';
  if (frac >= 0.6 || s >= 0.60) return 'C';
  if (frac >= 0.5 || s >= 0.50) return 'D';
  return 'F';
}

/* ========== LLM grading (primary method) ========== */
export async function gradeWithLLM({ caseObj, transcript, heur }) {
  const payload = buildLLMPayload({ caseObj, transcript, heur });

  // If FEEDBACK_MODE is heuristic only, skip LLM
  if (!CONFIG || (CONFIG.FEEDBACK_MODE === 'heuristic')) {
    console.debug('[LLM] skipped, FEEDBACK_MODE=heuristic');
    return { feedback: '(LLM disabled: FEEDBACK_MODE=heuristic)', score: heur };
  }

  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('jwt');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (CONFIG.API_KEY) {
    headers['x-api-key'] = CONFIG.API_KEY;
  }
  
  console.debug('[LLM] POST', CONFIG.FEEDBACK_API);

  let res;
  try {
    res = await fetch(CONFIG.FEEDBACK_API, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error('[LLM] network error', e);
    return { feedback: `Network error: ${e.message}`, score: heur };
  }

  console.debug('[LLM] status', res.status);
  
  if (!res.ok) {
    const txt = await res.text().catch(()=>'');
    console.warn('[LLM] error', res.status, txt);
    
    let msg = `LLM API error ${res.status}`;
    if (res.status === 401) msg += ' - Check authentication';
    else if (res.status === 403) msg += ' - Check permissions';
    else if (res.status === 429) msg += ' - Rate limit exceeded';
    else if (res.status >= 500) msg += ' - Server error';
    
    return { 
      feedback: `${msg}\n\n${txt}`,
      score: heur 
    };
  }
  
  const data = await res.json();
  console.debug('[LLM] success');
  
  // If LLM returns structured score data, use it
  if (data.rubricHit !== undefined && data.similarity !== undefined) {
    return {
      feedback: data.feedback || 'LLM feedback received',
      score: {
        similarity: data.similarity,
        rubricHit: data.rubricHit,
        rubricMiss: data.rubricMiss || ((caseObj.rubric?.length || 0) - data.rubricHit),
        hits: data.hits || [],
        misses: data.misses || [],
        isHeuristic: false
      }
    };
  }
  
  // Otherwise return whatever the LLM gave us
  return data;
}