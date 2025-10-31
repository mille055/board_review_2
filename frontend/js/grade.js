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
   - "dilated appendix" = "enlarged appendix" = ">6mm appendix" ✓ (measurement not required!)
   - "echogenicity of cortex is normal" = "cortical sparing" ✓
   - "no cortical involvement" = "cortical sparing" ✓
   - "hyperemia" in scrotal US = "hyperemia of epididymis" ✓

2. **Synonyms and paraphrases**: Recognize equivalent medical terminology
   - "heterogeneity" = "heterogeneous echotexture" = "varied appearance" ✓
   - "complicated fluid" = "complex fluid" = "septated collection" ✓
   - "enlargement" = "enlarged" = "increased size" = "dilated" ✓
   - "no perforation" = "no free air" = "no abscess" (when addressing complications) ✓
   - Specific measurements (">6mm") are NOT required if concept is clearly stated ✓

3. **Implicit information**: If they describe something that implies the rubric item, COUNT IT
   - Describing normal cortex while abnormal medulla implies cortical sparing ✓
   - Mentioning findings in proper anatomic context counts even without explicit anatomic qualifier ✓
   - "I would compare to the other side" = mentions contralateral comparison ✓
   - "dilated" or "enlarged" inherently implies abnormal size ✓

4. **Focus on knowledge demonstrated, not exact wording**: 
   - Did they show they understand the finding? → HIT
   - Did they use slightly different terminology? → Still a HIT
   - Did they describe the concept without naming it? → Still a HIT
   - Did they omit a specific measurement but describe the finding? → Still a HIT
   - Did they partially address it but miss key details? → PARTIAL

5. **Use PARTIAL for**:
   - Mentioned the concept but incomplete (e.g., said "enlargement" but didn't specify which structure)
   - Got most of it right but missed a critical qualifier
   - Demonstrated partial understanding but needs more detail

6. **Only mark as MISS if**:
   - They truly didn't mention or describe the concept at all
   - They got it wrong (not just worded differently)
   - The concept is completely absent from their response

REQUIRED OUTPUT FORMAT:
You MUST provide feedback in TWO parts:

PART 1 - Detailed Feedback (human-readable):
1) **What was done well:**
   [List specific strengths]

2) **Specific gaps or incorrect statements:**
   [List specific issues]

3) **Rubric mapping:**
   [For EACH rubric point, state Hit/Partial/Miss]
   - Rubric item 1: **Hit/Partial/Miss** - Brief explanation
   - Rubric item 2: **Hit/Partial/Miss** - Brief explanation
   [etc.]

4) **Coaching paragraph:**
   [Constructive feedback]

PART 2 - Structured Score (CRITICAL - THIS MUST BE PARSEABLE):
At the very end, include this exact format on separate lines:

SCORE_DATA_START
HITS: <number>
PARTIALS: <number>
MISSES: <number>
TOTAL: <number>
SIMILARITY: <0.00 to 1.00>
SCORE_DATA_END

Example:
SCORE_DATA_START
HITS: 7
PARTIALS: 1
MISSES: 1
TOTAL: 9
SIMILARITY: 0.83
SCORE_DATA_END

Note: SIMILARITY should be calculated as (HITS + 0.5*PARTIALS) / TOTAL

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
  console.log('[LLM] Raw response received:', JSON.stringify(data, null, 2));
  
  // Check if LLM returns structured score data
  if (data.rubricHit !== undefined && data.similarity !== undefined) {
    console.log('[LLM] ✅ Valid JSON format received');
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
  
  // Fallback: Parse text-based feedback
  const feedbackText = data.feedback || data.message || JSON.stringify(data);
  console.log('[LLM] ⚠️ No structured JSON, attempting to parse text feedback...');
  
  // Try to parse rubric mapping from text
  const parsedScore = parseTextFeedback(feedbackText, caseObj.rubric || []);
  
  if (parsedScore.rubricHit > 0 || parsedScore.rubricMiss > 0) {
    console.log('[LLM] ✅ Successfully parsed text feedback:', parsedScore);
    return {
      feedback: feedbackText,
      score: parsedScore
    };
  }
  
  // If parsing failed, return error
  console.error('[LLM] ❌ Could not parse feedback into scores');
  
  return {
    feedback: `⚠️ BACKEND ERROR: Invalid JSON format returned

Expected format:
{
  "rubricHit": 7,           ← NUMBER (missing or wrong type)
  "rubricMiss": 1,          ← NUMBER 
  "similarity": 0.875,      ← NUMBER between 0 and 1 (missing or wrong type)
  "hits": ["item1", ...],   ← ARRAY of strings
  "misses": ["item2"],      ← ARRAY of strings
  "feedback": "text..."     ← STRING
}

What your backend returned:
${JSON.stringify(data, null, 2)}

Check your backend console logs. The LLM prompt clearly asks for JSON.
Make sure your backend code extracts the JSON from the LLM response.`,
    score: {
      similarity: 0,
      rubricHit: 0,
      rubricMiss: caseObj.rubric?.length || 0,
      hits: [],
      misses: caseObj.rubric || [],
      isHeuristic: false
    }
  };
}

/* ========== Parse text-based feedback into structured score ========== */
function parseTextFeedback(feedbackText, rubric) {
  console.log('[parseTextFeedback] Parsing feedback...');
  console.log('[parseTextFeedback] Feedback length:', feedbackText.length, 'chars');
  
  // First, try to extract structured SCORE_DATA block
  const scoreDataMatch = feedbackText.match(/SCORE_DATA_START\s+([\s\S]*?)\s+SCORE_DATA_END/);
  
  if (scoreDataMatch) {
    console.log('[parseTextFeedback] Found SCORE_DATA block!');
    const scoreBlock = scoreDataMatch[1];
    
    const hitsMatch = scoreBlock.match(/HITS:\s*(\d+)/i);
    const partialsMatch = scoreBlock.match(/PARTIALS:\s*(\d+)/i);
    const missesMatch = scoreBlock.match(/MISSES:\s*(\d+)/i);
    const totalMatch = scoreBlock.match(/TOTAL:\s*(\d+)/i);
    const simMatch = scoreBlock.match(/SIMILARITY:\s*(\d*\.?\d+)/i);
    
    if (hitsMatch && missesMatch && simMatch) {
      const hits = parseInt(hitsMatch[1], 10);
      const partials = partialsMatch ? parseInt(partialsMatch[1], 10) : 0;
      const misses = parseInt(missesMatch[1], 10);
      const similarity = parseFloat(simMatch[1]);
      
      console.log('[parseTextFeedback] ✅ Parsed SCORE_DATA:', {
        hits,
        partials,
        misses,
        similarity: Math.round(similarity * 100) + '%'
      });
      
      return {
        similarity,
        rubricHit: hits,
        rubricPartial: partials,
        rubricMiss: misses,
        hits: [],
        misses: [],
        isHeuristic: false
      };
    }
  }
  
  // Fallback: parse from rubric mapping section
  let hits = 0;
  let partials = 0;
  let misses = 0;
  const hitsList = [];
  const partialsList = [];
  const missesList = [];
  
  // Look for the "3) Rubric mapping:" section
  const rubricSection = feedbackText.match(/3\)[\s\S]*?Rubric mapping:[\s\S]*?(?=4\)|$)/i);
  
  if (rubricSection) {
    const sectionText = rubricSection[0];
    console.log('[parseTextFeedback] Found rubric section');
    
    const lines = sectionText.split('\n');
    console.log('[parseTextFeedback] Processing', lines.length, 'lines');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5) continue;
      
      console.log('[parseTextFeedback] Checking line:', trimmed.substring(0, 80));
      
      // Match multiple patterns:
      // Pattern 1: "- **Item:** Hit" (bold item, plain status)
      // Pattern 2: "- Item: **Hit**" (plain item, bold status)
      // Pattern 3: "- Item: Hit" (all plain)
      
      // Check for Hit
      if (/:\s*Hit\b/i.test(trimmed)) {
        // Extract item text before the colon (remove any bold markers)
        const itemMatch = trimmed.match(/^[-•*]?\s*(.+?):\s*Hit\b/i);
        if (itemMatch) {
          hits++;
          const itemText = itemMatch[1].trim().replace(/\*\*/g, '');
          hitsList.push(itemText);
          console.log('[parseTextFeedback] ✅ HIT:', itemText);
        }
      }
      // Check for Partial
      else if (/:\s*Partial\b/i.test(trimmed)) {
        const itemMatch = trimmed.match(/^[-•*]?\s*(.+?):\s*Partial\b/i);
        if (itemMatch) {
          partials++;
          const itemText = itemMatch[1].trim().replace(/\*\*/g, '');
          partialsList.push(itemText);
          console.log('[parseTextFeedback] ⚠️ PARTIAL:', itemText);
        }
      }
      // Check for Miss
      else if (/:\s*Miss\b/i.test(trimmed)) {
        const itemMatch = trimmed.match(/^[-•*]?\s*(.+?):\s*Miss\b/i);
        if (itemMatch) {
          misses++;
          const itemText = itemMatch[1].trim().replace(/\*\*/g, '');
          missesList.push(itemText);
          console.log('[parseTextFeedback] ❌ MISS:', itemText);
        }
      }
    }
  } else {
    console.warn('[parseTextFeedback] Could not find "3) Rubric mapping:" section');
  }
  
  // Fallback: simple count of "Hit", "Partial", and "Miss" words (with or without bold)
  if (hits === 0 && misses === 0 && partials === 0) {
    console.log('[parseTextFeedback] No line-by-line matches, counting all Hit/Partial/Miss words...');
    
    // Count occurrences more carefully - look for them after colons or in bold
    const hitMatches = feedbackText.match(/:\s*\*\*Hit\*\*/gi) || 
                       feedbackText.match(/:\s*Hit\b/gi);
    const partialMatches = feedbackText.match(/:\s*\*\*Partial\*\*/gi) || 
                           feedbackText.match(/:\s*Partial\b/gi);
    const missMatches = feedbackText.match(/:\s*\*\*Miss\*\*/gi) || 
                        feedbackText.match(/:\s*Miss\b/gi);
    
    hits = hitMatches ? hitMatches.length : 0;
    partials = partialMatches ? partialMatches.length : 0;
    misses = missMatches ? missMatches.length : 0;
    
    console.log('[parseTextFeedback] Word count - Hits:', hits, 'Partials:', partials, 'Misses:', misses);
  }
  
  const totalRubric = rubric.length;
  const totalCounted = hits + partials + misses;
  
  console.log('[parseTextFeedback] Counted:', totalCounted, 'items (Hits:', hits, 'Partials:', partials, 'Misses:', misses, ') vs Rubric:', totalRubric);
  
  // Validate counts
  if (totalCounted > totalRubric) {
    console.warn('[parseTextFeedback] Counted more items than rubric has, scaling down');
    const scale = totalRubric / totalCounted;
    hits = Math.round(hits * scale);
    partials = Math.round(partials * scale);
    misses = totalRubric - hits - partials;
  } else if (totalCounted < totalRubric) {
    console.warn('[parseTextFeedback] Counted fewer items than rubric has, assuming rest are misses');
    misses = totalRubric - hits - partials;
  }
  
  // Calculate similarity: full credit for hits, half credit for partials
  const similarity = totalRubric > 0 ? (hits + (partials * 0.5)) / totalRubric : 0;
  
  console.log('[parseTextFeedback] Final score:', {
    hits,
    partials,
    misses,
    totalRubric,
    similarity: Math.round(similarity * 100) + '%'
  });
  
  return {
    similarity,
    rubricHit: hits,
    rubricPartial: partials,
    rubricMiss: misses,
    hits: hitsList,
    partials: partialsList,
    misses: missesList,
    isHeuristic: false
  };
}