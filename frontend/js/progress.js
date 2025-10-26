const KEY = 'rb_progress_v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { attempts: [] }; }
  catch { return { attempts: [] }; }
}

function save(data) { localStorage.setItem(KEY, JSON.stringify(data)); }

export function recordAttempt({ caseId, subspecialty, similarity, rubricHit, rubricTotal, letter, type }) {
  const data = load();
  data.attempts.push({
    ts: Date.now(),
    caseId, 
    subspecialty,
    similarity, 
    rubricHit, 
    rubricTotal, 
    letter,
    type: type || 'oral' // ADD: default to 'oral' for backwards compatibility
  });
  save(data);
  console.log(`✓ ${(type || 'oral').toUpperCase()} attempt recorded:`, caseId, `${Math.round(similarity * 100)}%`);
}

export function getStats(totalCases) {
  const { attempts } = load();
  const reviewedSet = new Set(attempts.map(a => a.caseId));
  const reviewedCount = reviewedSet.size;
  
  // Separate by type
  const oralAttempts = attempts.filter(a => !a.type || a.type === 'oral');
  const mcqAttempts = attempts.filter(a => a.type === 'mcq');
  
  // Per-subspecialty summary
  const per = {};
  for (const a of attempts) {
    per[a.subspecialty] ||= { attempts: 0, meanSim: 0, meanRubric: 0, lastLetter: '-', hits: 0, total: 0 };
    const p = per[a.subspecialty];
    p.attempts += 1;
    p.meanSim += a.similarity;
    p.hits += a.rubricHit;
    p.total += a.rubricTotal || 0;
    p.lastLetter = a.letter;
  }
  
  for (const k in per) {
    const p = per[k];
    p.meanSim = p.attempts ? Math.round((p.meanSim / p.attempts) * 100) : 0;
    p.meanRubric = p.total ? Math.round((p.hits / p.total) * 100) : 0;
  }
  
  // Calculate averages by type
  const avgOralScore = oralAttempts.length 
    ? oralAttempts.reduce((sum, a) => sum + (a.similarity || 0), 0) / oralAttempts.length
    : 0;
  const avgMCQScore = mcqAttempts.length
    ? mcqAttempts.reduce((sum, a) => sum + (a.similarity || 0), 0) / mcqAttempts.length
    : 0;
  
  return { 
    reviewedCount, 
    totalCases, 
    per, 
    attempts,
    oralAttempts,    // ADD: filtered oral attempts
    mcqAttempts,     // ADD: filtered MCQ attempts
    avgOralScore,    // ADD: average oral score
    avgMCQScore      // ADD: average MCQ score
  };
}

// NEW: Get performance breakdown by type
export function getPerformanceByType() {
  const { oralAttempts, mcqAttempts } = getStats();
  
  return {
    oral: {
      count: oralAttempts.length,
      avgPercentage: oralAttempts.length
        ? Math.round((oralAttempts.reduce((sum, a) => sum + (a.similarity || 0), 0) / oralAttempts.length) * 100)
        : 0
    },
    mcq: {
      count: mcqAttempts.length,
      avgPercentage: mcqAttempts.length
        ? Math.round((mcqAttempts.reduce((sum, a) => sum + (a.similarity || 0), 0) / mcqAttempts.length) * 100)
        : 0
    }
  };
}