import { CONFIG } from './config.js';

function fmtDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0,10);
}

function mean(list){ return list.length ? list.reduce((a,b)=>a+b,0)/list.length : 0; }

async function fetchAttempts(){
  const headers = {};
  const token = localStorage.getItem('jwt');

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (CONFIG.API_KEY) {
    headers['x-api-key'] = CONFIG.API_KEY;
  }

  // 1) Try the (optional) detail endpoint if you later add it
  try {
    const r = await fetch('/api/progress/attempts', { headers, cache:'no-store' });
    if (r.ok) return r.json();
  } catch {}

  // 2) Fall back to the summary endpoint and expand to synthetic rows
  try {
    const r2 = await fetch('/api/progress', { headers, cache:'no-store' });
    if (r2.ok) {
      const sum = await r2.json(); // { reviewedCount, per: { sub: {attempts, meanSim, meanRubric} } }
      const rows = [];
      const now = Date.now();
      // make N synthetic attempts per subspecialty so your charts can render
      Object.entries(sum.per || {}).forEach(([sub, stats])=>{
        const n = Number(stats.attempts || 0);
        const sim = Number(stats.meanSim || 0) / 100; // UI expects 0–1 similarity
        for (let i=0;i<n;i++){
          rows.push({
            caseId: `${sub.slice(0,3).toLowerCase()}-${i+1}`,
            subspecialty: sub,
            similarity: sim,
            ts: now - (n-i)*86400000 // spread over past n days
          });
        }
      });
      if (rows.length) return rows;
    }
  } catch {}

  // 3) Final fallback: local sample file you place in /frontend/data/
  const r3 = await fetch('data/attempts_sample.json', { cache:'no-store' });
  if (!r3.ok) throw new Error('No progress data available');
  return r3.json();
}

// async function fetchProgress() {
//   try {
//     const r = await fetch('/api/progress', { headers: authHeaders() });
//     if (!r.ok) throw new Error('api failed');
//     return await r.json();
//   } catch {
//     // fallback to sample file
//     const r2 = await fetch('data/progress_sample.json', { cache: 'no-store' });
//     return await r2.json();
//   }
// }
async function fetchProgress() {
  const token = localStorage.getItem('jwt');
  const headers = {};
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  } else if (CONFIG.API_KEY) {
    headers['x-api-key'] = CONFIG.API_KEY;
  }
  
  try {
    const r = await fetch('/api/progress', { headers });
    if (!r.ok) throw new Error('api failed');
    return await r.json();
  } catch {
    // fallback to sample file
    const r2 = await fetch('data/progress_sample.json', { cache: 'no-store' });
    return await r2.json();
  }
}

function buildTimeSeries(rows){
  // group by day
  const byDay = new Map();
  rows.forEach(r=>{
    const day = fmtDay(r.ts || Date.now());
    const sim = Number(r.similarity || 0);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(sim);
  });
  const days = [...byDay.keys()].sort();
  return {
    labels: days,
    values: days.map(d=> Math.round(mean(byDay.get(d))*100))
  };
}

function buildBySubspecialty(rows){
  const bySub = new Map();
  rows.forEach(r=>{
    const sub = r.subspecialty || 'Unknown';
    const sim = Number(r.similarity || 0);
    if (!bySub.has(sub)) bySub.set(sub, []);
    bySub.get(sub).push(sim);
  });
  const subs = [...bySub.keys()].sort();
  return {
    labels: subs,
    values: subs.map(s=> Math.round(mean(bySub.get(s))*100))
  };
}

let chartTime=null, chartSubs=null;

function ensureChart(ctx, cfg){
  if (ctx._chart) { ctx._chart.destroy(); }
  ctx._chart = new Chart(ctx, cfg);
  return ctx._chart;
}

export async function openProgressModal(){
  const modal = document.getElementById('progressModal');
  const summary = document.getElementById('progressSummary');
  const ctxTime = document.getElementById('chartTime').getContext('2d');
  const ctxSubs = document.getElementById('chartSubs').getContext('2d');

  try{
    const rows = await fetchAttempts();
    const uniqueCases = new Set(rows.map(r=>r.caseId)).size;

    const ts = buildTimeSeries(rows);
    const subs = buildBySubspecialty(rows);

    summary.textContent = `Reviewed ${uniqueCases} unique case${uniqueCases===1?'':'s'} • ${rows.length} total attempts`;

    chartTime = ensureChart(ctxTime, {
      type: 'line',
      data: {
        labels: ts.labels,
        datasets: [{
          label: 'Mean similarity (%)',
          data: ts.values,
          tension: 0.3,
          fill: false
        }]
      },
      options: {
        responsive: true,
        animation: false,
        scales: {
          y: { beginAtZero: true, max: 100, ticks: { stepSize: 20 } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: {
            label: (ctx)=> ` ${ctx.parsed.y}%`
          } }
        }
      }
    });

    chartSubs = ensureChart(ctxSubs, {
      type: 'bar',
      data: {
        labels: subs.labels,
        datasets: [{ label: 'Mean similarity (%)', data: subs.values }]
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
          tooltip: { callbacks: {
            label: (ctx)=> ` ${ctx.parsed.x}%`
          } }
        }
      }
    });

    modal.classList.add('show');
  }catch(e){
    console.error('Progress modal error', e);
    alert('Could not load progress.');
  }
}

export function bindProgressModal(){
  const openBtn = document.getElementById('openProgress');
  const closeBtn = document.getElementById('closeProgress');
  const modal = document.getElementById('progressModal');
  const backdrop = modal?.querySelector('.modal-backdrop');

  openBtn?.addEventListener('click', openProgressModal);
  const close = ()=> modal?.classList.remove('show');
  closeBtn?.addEventListener('click', close);
  backdrop?.addEventListener('click', close);
}
