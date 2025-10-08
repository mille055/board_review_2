import { CONFIG } from './config.js';

function fmtDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0,10);
}

function fmtWeek(ts) {
  const d = new Date(ts);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().slice(0,10);
}

function mean(list) { 
  return list.length ? list.reduce((a,b)=>a+b,0)/list.length : 0; 
}

function filterByTimeRange(rows, range) {
  const now = Date.now();
  const cutoffs = {
    today: now - 24*60*60*1000,
    week: now - 7*24*60*60*1000,
    '2weeks': now - 14*24*60*60*1000,
    month: now - 30*24*60*60*1000,
    all: 0
  };
  const cutoff = cutoffs[range] || 0;
  return rows.filter(r => (r.ts || 0) >= cutoff);
}

async function fetchAttempts() {
  console.log('[Progress] Fetching attempts...');
  
  // FIRST: Try localStorage (where progress.js stores data)
  try {
    const KEY = 'rb_progress_v1';
    const stored = localStorage.getItem(KEY);
    if (stored) {
      const data = JSON.parse(stored);
      if (data.attempts && data.attempts.length > 0) {
        console.log('[Progress] Found', data.attempts.length, 'attempts in localStorage');
        return data.attempts;
      }
    }
  } catch (e) {
    console.log('[Progress] localStorage read failed:', e);
  }

  // SECOND: Try API
  const headers = {};
  const token = localStorage.getItem('jwt');

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (CONFIG.API_KEY) {
    headers['x-api-key'] = CONFIG.API_KEY;
  }

  try {
    const r = await fetch('/api/progress/attempts', { headers, cache:'no-store' });
    console.log('[Progress] API /attempts response:', r.status);
    if (r.ok) {
      const data = await r.json();
      console.log('[Progress] Got data from API:', data.length, 'attempts');
      return data;
    }
  } catch (e) {
    console.log('[Progress] API /attempts error:', e);
  }

  try {
    const r2 = await fetch('/api/progress', { headers, cache:'no-store' });
    console.log('[Progress] API /progress response:', r2.status);
    if (r2.ok) {
      const sum = await r2.json();
      console.log('[Progress] Got summary:', sum);
      const rows = [];
      const now = Date.now();
      Object.entries(sum.per || {}).forEach(([sub, stats])=>{
        const n = Number(stats.attempts || 0);
        const sim = Number(stats.meanSim || 0) / 100;
        for (let i=0;i<n;i++){
          rows.push({
            caseId: `${sub.slice(0,3).toLowerCase()}-${i+1}`,
            subspecialty: sub,
            similarity: sim,
            letter: 'B',
            ts: now - (n-i)*86400000
          });
        }
      });
      if (rows.length) {
        console.log('[Progress] Converted summary to', rows.length, 'rows');
        return rows;
      }
    }
  } catch (e) {
    console.log('[Progress] API /progress failed:', e);
  }

  // Return empty array instead of throwing - allows modal to work with no data
  console.log('[Progress] No data found anywhere, returning empty array');
  return [];
}

function buildTimeSeries(rows) {
  const byDay = new Map();
  rows.forEach(r=>{
    const day = fmtDay(r.ts || Date.now());
    const sim = Number(r.similarity || 0);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(sim);
  });
  const days = [...byDay.keys()].sort();
  return {
    labels: days.map(d => {
      const date = new Date(d);
      return `${date.getMonth()+1}/${date.getDate()}`;
    }),
    values: days.map(d=> Math.round(mean(byDay.get(d))*100))
  };
}

function buildBySubspecialty(rows) {
  const bySub = new Map();
  rows.forEach(r=>{
    const sub = r.subspecialty || 'Unknown';
    const sim = Number(r.similarity || 0);
    if (!bySub.has(sub)) bySub.set(sub, []);
    bySub.get(sub).push(sim);
  });
  
  const subs = [...bySub.keys()].sort();
  const values = subs.map(s=> Math.round(mean(bySub.get(s))*100));
  
  // Color code by performance
  const colors = values.map(v => {
    if (v >= 75) return '#4CAF50'; // Green - proficient
    if (v >= 60) return '#FFA726'; // Orange - needs work
    return '#EF5350'; // Red - at risk
  });
  
  return { labels: subs, values, colors };
}

function buildWeeklyActivity(rows) {
  const byWeek = new Map();
  rows.forEach(r=>{
    const week = fmtWeek(r.ts || Date.now());
    if (!byWeek.has(week)) byWeek.set(week, { count: 0, totalSim: 0 });
    const data = byWeek.get(week);
    data.count++;
    data.totalSim += Number(r.similarity || 0);
  });
  
  const weeks = [...byWeek.keys()].sort();
  return {
    labels: weeks.map(w => {
      const d = new Date(w);
      return `${d.getMonth()+1}/${d.getDate()}`;
    }),
    counts: weeks.map(w => byWeek.get(w).count),
    avgScores: weeks.map(w => Math.round((byWeek.get(w).totalSim / byWeek.get(w).count) * 100))
  };
}

function buildGradeDistribution(rows) {
  const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  rows.forEach(r => {
    const grade = r.letter || 'F';
    if (grades.hasOwnProperty(grade)) grades[grade]++;
  });
  
  return {
    labels: Object.keys(grades),
    values: Object.values(grades),
    colors: ['#4CAF50', '#8BC34A', '#FFC107', '#FF9800', '#EF5350']
  };
}

function findLowestScores(rows, n = 10) {
  return [...rows]
    .sort((a, b) => (a.similarity || 0) - (b.similarity || 0))
    .slice(0, n);
}

function renderSummaryStats(rows, range) {
  const summary = document.getElementById('progressSummary');
  if (!summary) return;
  
  const uniqueCases = new Set(rows.map(r => r.caseId)).size;
  const totalAttempts = rows.length;
  const avgScore = Math.round(mean(rows.map(r => r.similarity || 0)) * 100);
  const recentScore = rows.length > 0 
    ? Math.round((rows[rows.length - 1].similarity || 0) * 100)
    : 0;
  
  // Count at-risk subspecialties
  const bySub = new Map();
  rows.forEach(r => {
    const sub = r.subspecialty || 'Unknown';
    if (!bySub.has(sub)) bySub.set(sub, []);
    bySub.get(sub).push(r.similarity || 0);
  });
  const atRiskSubs = [...bySub.entries()]
    .filter(([_, scores]) => mean(scores) * 100 < 60)
    .length;
  
  const rangeLabel = {
    today: 'Today',
    week: 'Last 7 Days',
    '2weeks': 'Last 14 Days',
    month: 'Last 30 Days',
    all: 'All Time'
  }[range] || 'Selected Period';
  
  summary.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">${rangeLabel}</div>
      <div class="stat-value">${uniqueCases}</div>
      <div class="stat-label">Unique Cases</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Attempts</div>
      <div class="stat-value">${totalAttempts}</div>
      <div class="stat-label">${(totalAttempts / Math.max(uniqueCases, 1)).toFixed(1)} avg/case</div>
    </div>
    <div class="stat-card ${avgScore >= 75 ? '' : avgScore >= 60 ? 'warning' : 'danger'}">
      <div class="stat-label">Average Score</div>
      <div class="stat-value">${avgScore}%</div>
      <div class="stat-label">${avgScore >= 75 ? 'Proficient' : avgScore >= 60 ? 'Needs Work' : 'At Risk'}</div>
    </div>
    <div class="stat-card ${recentScore >= 75 ? '' : recentScore >= 60 ? 'warning' : 'danger'}">
      <div class="stat-label">Most Recent</div>
      <div class="stat-value">${recentScore}%</div>
      <div class="stat-label">Last attempt</div>
    </div>
    <div class="stat-card ${atRiskSubs > 0 ? 'danger' : ''}">
      <div class="stat-label">At-Risk Areas</div>
      <div class="stat-value">${atRiskSubs}</div>
      <div class="stat-label">Subspecialties &lt;60%</div>
    </div>
  `;
}

function renderMissedCases(rows) {
  const container = document.getElementById('missedCases');
  if (!container) return;
  
  const lowest = findLowestScores(rows, 10);
  
  if (lowest.length === 0) {
    container.innerHTML = '<div class="small" style="color:#999;padding:10px;">No attempts yet</div>';
    return;
  }
  
  container.innerHTML = lowest.map(r => {
    const score = Math.round((r.similarity || 0) * 100);
    const badgeClass = score >= 75 ? 'proficient' : score >= 60 ? 'needs-work' : 'at-risk';
    const badgeText = score >= 75 ? 'Proficient' : score >= 60 ? 'Needs Work' : 'At Risk';
    
    return `
      <div class="missed-case-item">
        <div>
          <div><strong>${r.caseId || 'Unknown'}</strong></div>
          <div style="color:#999;font-size:11px;">${r.subspecialty || 'Unknown'}</div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;">
          <span class="badge ${badgeClass}">${badgeText}</span>
          <span style="font-weight:bold;color:${score >= 75 ? '#4CAF50' : score >= 60 ? '#FFA726' : '#EF5350'}">${score}%</span>
        </div>
      </div>
    `;
  }).join('');
}

let chartTime, chartSubs, chartWeekly, chartGrades;

function ensureChart(ctx, cfg) {
  if (ctx._chart) ctx._chart.destroy();
  ctx._chart = new Chart(ctx, cfg);
  return ctx._chart;
}

async function renderDashboard(range = 'week') {
  console.log('[Progress] Rendering dashboard for range:', range);
  
  const summary = document.getElementById('progressSummary');
  if (!summary) {
    console.error('[Progress] progressSummary element not found!');
    return;
  }
  
  try {
    const allRows = await fetchAttempts();
    console.log('[Progress] Total rows fetched:', allRows.length);
    
    const rows = filterByTimeRange(allRows, range);
    console.log('[Progress] Filtered to', rows.length, 'rows for range:', range);
    
    if (rows.length === 0) {
      console.log('[Progress] No data for this range, showing message');
      summary.innerHTML = 
        '<div class="small" style="color:#999;padding:20px;text-align:center;grid-column:1/-1;">No data for selected time range. Try "All Time".</div>';
      
      // Clear/destroy existing charts
      if (chartTime) { chartTime.destroy(); chartTime = null; }
      if (chartSubs) { chartSubs.destroy(); chartSubs = null; }
      if (chartWeekly) { chartWeekly.destroy(); chartWeekly = null; }
      if (chartGrades) { chartGrades.destroy(); chartGrades = null; }

      // Clear chart canvases
      const canvases = ['chartTime', 'chartSubs', 'chartWeekly', 'chartGrades'];
      canvases.forEach(id => {
        const canvas = document.getElementById(id);
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      });

      // Clear other sections too
      const missedCases = document.getElementById('missedCases');
      if (missedCases) missedCases.innerHTML = '<div class="small" style="color:#999;padding:10px;">No attempts yet</div>';
      
      return;
    }

    console.log('[Progress] Rendering stats...');
    renderSummaryStats(rows, range);
    
    console.log('[Progress] Rendering missed cases...');
    renderMissedCases(rows);

    console.log('[Progress] Building chart data...');
    const ts = buildTimeSeries(rows);
    const subs = buildBySubspecialty(rows);
    const weekly = buildWeeklyActivity(rows);
    const grades = buildGradeDistribution(rows);

    console.log('[Progress] Rendering time series chart...');
    const ctxTime = document.getElementById('chartTime')?.getContext('2d');
    if (!ctxTime) {
      console.error('[Progress] chartTime canvas not found!');
      return;
    }
    
    chartTime = ensureChart(ctxTime, {
      type: 'line',
      data: {
        labels: ts.labels,
        datasets: [{
          label: 'Average Score (%)',
          data: ts.values,
          tension: 0.3,
          borderColor: '#4CAF50',
          backgroundColor: 'rgba(76, 175, 80, 0.1)',
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: {
          y: { beginAtZero: true, max: 100, ticks: { stepSize: 20 } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => ` ${ctx.parsed.y}%` } }
        }
      }
    });

    // Rest of the charts... (keep as before)
    console.log('[Progress] Rendering subspecialty chart...');
    const ctxSubs = document.getElementById('chartSubs')?.getContext('2d');
    if (ctxSubs) {
      chartSubs = ensureChart(ctxSubs, {
        type: 'bar',
        data: {
          labels: subs.labels,
          datasets: [{
            label: 'Average Score (%)',
            data: subs.values,
            backgroundColor: subs.colors
          }]
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          animation: false,
          scales: {
            x: { beginAtZero: true, max: 100, ticks: { stepSize: 20 } }
          },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (ctx) => ` ${ctx.parsed.x}%` } }
          }
        }
      });
    }

    console.log('[Progress] Rendering weekly chart...');
    const ctxWeekly = document.getElementById('chartWeekly')?.getContext('2d');
    if (ctxWeekly) {
      chartWeekly = ensureChart(ctxWeekly, {
        type: 'bar',
        data: {
          labels: weekly.labels,
          datasets: [
            {
              label: 'Cases Attempted',
              data: weekly.counts,
              backgroundColor: '#2196F3',
              yAxisID: 'y'
            },
            {
              label: 'Avg Score (%)',
              data: weekly.avgScores,
              type: 'line',
              borderColor: '#4CAF50',
              tension: 0.3,
              yAxisID: 'y1'
            }
          ]
        },
        options: {
          responsive: true,
          animation: false,
          scales: {
            y: { type: 'linear', position: 'left', beginAtZero: true, title: { display: true, text: 'Cases' } },
            y1: { type: 'linear', position: 'right', beginAtZero: true, max: 100, title: { display: true, text: 'Score %' }, grid: { drawOnChartArea: false } }
          },
          plugins: {
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  if (ctx.dataset.label === 'Cases Attempted') return ` ${ctx.parsed.y} cases`;
                  return ` ${ctx.parsed.y}%`;
                }
              }
            }
          }
        }
      });
    }

    console.log('[Progress] Rendering grade distribution chart...');
    const ctxGrades = document.getElementById('chartGrades')?.getContext('2d');
    if (ctxGrades) {
      chartGrades = ensureChart(ctxGrades, {
        type: 'doughnut',
        data: {
          labels: grades.labels,
          datasets: [{
            data: grades.values,
            backgroundColor: grades.colors
          }]
        },
        options: {
          responsive: true,
          animation: false,
          plugins: {
            legend: { position: 'right' },
            tooltip: {
              callbacks: {
                label: (ctx) => ` ${ctx.label}: ${ctx.parsed} (${Math.round(ctx.parsed / rows.length * 100)}%)`
              }
            }
          }
        }
      });
    }

    console.log('[Progress] Dashboard rendered successfully!');

  } catch (e) {
    console.error('[Progress] Dashboard error:', e);
    console.error('[Progress] Error stack:', e.stack);
    summary.innerHTML = `<div class="small" style="color:#EF5350;padding:20px;text-align:center;grid-column:1/-1;">Error loading progress: ${e.message}<br><br>Check console for details.</div>`;
  }
}

// Clear all progress data
function clearAllProgress() {
  if (!confirm('This will delete all your progress data. Are you sure?')) {
    return;
  }
  
  const KEY = 'rb_progress_v1';
  localStorage.removeItem(KEY);
  console.log('[Progress] Cleared all data');
  
  // Refresh the dashboard
  const select = document.getElementById('timeRangeSelect');
  const currentRange = select?.value || 'week';
  renderDashboard(currentRange);
  
  alert('All progress data cleared!');
}

// Load sample data into localStorage
async function loadSampleProgress() {
  if (!confirm('This will replace your current progress with sample data. Continue?')) {
    return;
  }
  
  try {
    const r = await fetch('data/attempts_sample.json', { cache:'no-store' });
    if (!r.ok) throw new Error('Could not load sample data');
    
    const sampleData = await r.json();
    
    // Store in localStorage
    const KEY = 'rb_progress_v1';
    localStorage.setItem(KEY, JSON.stringify({ attempts: sampleData }));
    
    console.log('[Progress] Loaded', sampleData.length, 'sample attempts');
    
    // Refresh the dashboard
    const select = document.getElementById('timeRangeSelect');
    const currentRange = select?.value || 'all'; // Show all for demo
    if (select) select.value = 'all';
    await renderDashboard('all');
    
    alert(`Loaded ${sampleData.length} sample attempts!`);
  } catch (e) {
    console.error('[Progress] Failed to load sample data:', e);
    alert('Could not load sample data. Check console for details.');
  }
}
export async function openProgressModal() {
  const modal = document.getElementById('progressModal');
  modal.classList.add('show');
  
  const select = document.getElementById('timeRangeSelect');
  const currentRange = select?.value || 'week';
  await renderDashboard(currentRange);
}

export function bindProgressModal() {
  console.log('[Progress] Binding modal...');
  const openBtn = document.getElementById('openProgress');
  const closeBtn = document.getElementById('closeProgress');
  const clearBtn = document.getElementById('clearProgress');
  const loadSampleBtn = document.getElementById('loadSampleProgress');
  const modal = document.getElementById('progressModal');
  const backdrop = modal?.querySelector('.modal-backdrop');
  const timeSelect = document.getElementById('timeRangeSelect');

  console.log('[Progress] Elements found:', {
    openBtn: !!openBtn,
    closeBtn: !!closeBtn,
    clearBtn: !!clearBtn,
    loadSampleBtn: !!loadSampleBtn,
    modal: !!modal,
    backdrop: !!backdrop,
    timeSelect: !!timeSelect
  });

  if (!openBtn || !closeBtn || !modal) {
    console.error('[Progress] Missing required elements!');
    return;
  }

  openBtn.addEventListener('click', () => {
    console.log('[Progress] Opening modal...');
    openProgressModal();
  });
  
  const close = () => {
    console.log('[Progress] Closing modal...');
    modal.classList.remove('show');
  };
  
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    close();
  });
  
  backdrop?.addEventListener('click', close);
  
  // Clear button
  clearBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    clearAllProgress();
  });
  
  // Load sample button
  loadSampleBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    await loadSampleProgress();
  });
  
  timeSelect?.addEventListener('change', async (e) => {
    console.log('[Progress] Time range changed to:', e.target.value);
    await renderDashboard(e.target.value);
  });
  
  console.log('[Progress] Modal bound successfully');
}