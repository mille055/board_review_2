const KEY = 'rb_progress_v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { attempts: [] }; }
  catch { return { attempts: [] }; }
}
function save(data) { localStorage.setItem(KEY, JSON.stringify(data)); }

export function recordAttempt({ caseId, subspecialty, similarity, rubricHit, rubricTotal, letter }) {
  const data = load();
  data.attempts.push({
    ts: Date.now(),
    caseId, subspecialty,
    similarity, rubricHit, rubricTotal, letter
  });
  save(data);
}

export function getStats(totalCases) {
  const { attempts } = load();
  const reviewedSet = new Set(attempts.map(a => a.caseId));
  const reviewedCount = reviewedSet.size;

  // Per-subspecialty summary
  const per = {};
  for (const a of attempts) {
    per[a.subspecialty] ||= { attempts: 0, meanSim: 0, meanRubric: 0, lastLetter: '-', hits: 0, total: 0 };
    const p = per[a.subspecialty];
    p.attempts += 1;
    p.meanSim   += a.similarity;
    p.hits     += a.rubricHit;
    p.total    += a.rubricTotal || 0;
    p.lastLetter = a.letter;
  }
  for (const k in per) {
    const p = per[k];
    p.meanSim   = p.attempts ? Math.round((p.meanSim / p.attempts) * 100) : 0;
    p.meanRubric = p.total ? Math.round((p.hits / p.total) * 100) : 0;
  }

  return { reviewedCount, totalCases, per, attempts };
}
