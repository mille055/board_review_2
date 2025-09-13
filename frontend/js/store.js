import { CONFIG } from './config.js';

let CASES = [];
let filters = { subs: new Set(), query: '' };

export async function loadCases(url = CONFIG.CASES_URL){
  try{
    const r = await fetch(url, {cache:'no-store'});
    CASES = r.ok ? await r.json() : [];
  }catch{ CASES = []; }
}
export function setCases(arr){ CASES = Array.isArray(arr) ? arr : []; }
export function getAll(){ return CASES.slice(); }

export function setFilters({subs, query}){
  if(subs) filters.subs = subs;
  filters.query = (query ?? '').toLowerCase();
}
export function filteredCases(){
  return CASES.filter(c=>{
    const okSub = filters.subs.size ? filters.subs.has(c.subspecialty) : true;
    const hay = [c.title,c.boardPrompt,c.expectedAnswer,(c.tags||[]).join(' '),(c.subspecialty||'')].join(' ').toLowerCase();
    const okQ = filters.query ? hay.includes(filters.query) : true;
    return okSub && okQ;
  });
}
export function randomFrom(list = filteredCases()){
  return list.length ? list[Math.floor(Math.random()*list.length)] : null;
}
