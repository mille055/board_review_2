// concepts.js
export const CONCEPTS = {
  // ====== Findings (abdomen examples) ======
  "finding.appendix_dilated": {
    label: "Enlarged/dilated appendix (>6 mm)",
    synonyms: [">6 mm", "greater than 6 mm", "dilated appendix", "enlarged appendix", "increased caliber", "noncompressible appendix"],
    pattern: /\b(enlarged|dilated|noncompressible)\s+append(?:ix|ice)s\b|>\s*6\s*mm|\bgreater\s+than\s+6\s*mm\b/i,
  },
  "finding.stranding": {
    label: "Periappendiceal/fat stranding",
    synonyms: ["periappendiceal stranding", "fat stranding", "inflammatory stranding", "inflammatory changes", "RLQ stranding"],
    detect: (t) => {
      const DIRECT = /\b((peri[-\s]?appendice(?:al|ar)\s+)?(fat\s+)?stranding|inflammatory\s+changes?)\b/i;
      if (DIRECT.test(t)) return { hit: true, quote: (t.match(DIRECT)||[""])[0] };
      const STRAND = /\bstranding\b/i;
      const CONTEXT = /\b(append(?:ix|ice|iceal|icear)|rlq|right\s+lower\s+quadrant|cecal|peri[-\s]?append)/i;
      const lower = t.toLowerCase();
      for (const m of lower.matchAll(STRAND)) {
        const s = Math.max(0, m.index - 90), e = Math.min(lower.length, m.index + m[0].length + 90);
        if (CONTEXT.test(lower.slice(s, e))) return { hit: true, quote: "stranding" };
      }
      return { hit: false };
    }
  },
  "finding.periappendiceal_fluid": {
    label: "Periappendiceal fluid / free fluid",
    synonyms: ["periappendiceal fluid", "free fluid", "fluid surrounding the appendix"],
    pattern: /\b(periappendiceal\s+fluid|free\s+fluid|fluid\b)\b/i,
  },
  "finding.appendicolith": {
    label: "Appendicolith",
    synonyms: ["appendicolith", "fecalith", "coprolith", "appendiceal stone"],
    pattern: /\b(appendicolith|fecalith|coprolith|appendiceal\s+stone)\b/i,
  },
  "finding.perforation_abscess": {
    label: "Complications (perforation/abscess/free air)",
    synonyms: ["perforation", "perforated", "free air", "extraluminal air", "abscess", "phlegmon", "fluid collection", "wall discontinuity"],
    pattern: /\b(perforation|perforated|free\s+air|extraluminal\s+air|abscess|phlegmon|fluid\s+collection|wall\s+discontinuity)\b/i,
  },
  "finding.echogenic_pyramids": {
    label: "Echogenic medullary pyramids",
    synonyms: [
      "echogenic pyramids", "echogenic medullary pyramids",
      "bright pyramids", "hyperechoic pyramids", "medullary echogenicity"
    ],
    detect: (t) => {
      const DIRECT = /\b(echogenic|hyperechoic|bright)\s+(medullary\s+)?pyramids?\b/i;
      if (DIRECT.test(t)) return { hit: true, quote: (t.match(DIRECT)||[""])[0] };
      const ok = coOccurs(t, /\b(echogenic|hyperechoic|bright)\b/.source,
                             /\b(medullary|pyramids?)\b/.source, 90);
      return ok ? { hit: true, quote: "echogenic … pyramids" } : { hit: false };
    }
  },
  "finding.posterior_acoustic_shadowing": {
    label: "Posterior acoustic shadowing",
    synonyms: ["posterior acoustic shadowing", "acoustic shadowing", "clean shadowing", "shadowing artifact"],
    pattern: /\b(posterior\s+)?acoustic\s+shadow(ing)?\b|\bclean\s+shadow(ing)?\b/i
  },
  "finding.cortical_sparing": {
    label: "Cortical sparing (medulla > cortex echogenicity)",
    synonyms: ["cortical sparing", "cortex spared", "medulla greater than cortex echogenicity", "medulla > cortex"],
    detect: (t) => {
      const DIRECT = /\bcortical\s+sparing\b|\bcortex\s+spared\b/i;
      if (DIRECT.test(t)) return { hit: true, quote: (t.match(DIRECT)||[""])[0] };
      const comp = coOccurs(t, /\b(medulla(ry)?|pyramids?)\b/.source,
                               /\b(>|\bgreater\s+than\b).{0,20}\bcortex\b/.source, 90);
      return comp ? { hit: true, quote: "medulla > cortex" } : { hit: false };
    }
  },
  "finding.twinkle_artifact": {
    label: "Twinkle artifact on color Doppler",
    synonyms: ["twinkle artifact", "color twinkle"],
    pattern: /\btwinkle\s+artifact\b|\bcolor\s+twinkle\b/i
  },
  "finding.stones_nonobstructing": {
    label: "Non-obstructing renal stones",
    synonyms: ["nonobstructing stone", "punctate stones", "calcifications within pyramids"],
    detect: (t) => {
      const stone = /\b(stone|stones|calculi|calcifications?)\b/i;
      const nonobs = /\b(non-?obstruct(ing|ive)|no\s+hydronephrosis)\b/i;
      if (stone.test(t) && (nonobs.test(t) || isNegated(t, /\bhydronephrosis\b/i))) {
        return { hit: true, quote: (t.match(stone)||["stones"])[0] };
      }
      return { hit: false };
    }
  },
  "finding.hydronephrosis": {
    label: "Hydronephrosis mentioned",
    synonyms: ["hydronephrosis"],
    detect: (t) => {
      const POS = /\bhydronephrosis\b/i;
      if (isNegated(t, POS)) return { hit: true, quote: "no hydronephrosis" }; // counts as “addressed”
      return POS.test(t) ? { hit: true, quote: "hydronephrosis" } : { hit: false };
    }
  },

  // ====== Actions / Management ======
  "action.surgery_consult": {
    label: "Recommends surgery / surgical consult / appendectomy",
    synonyms: ["surgical consult", "surgical consultation", "surgery", "appendectomy"],
    pattern: /\b(surgical\s+consult(?:ation)?|surgery|appendectomy)\b/i,
  },
  "action.antibiotics": {
    label: "Mentions antibiotics",
    synonyms: ["antibiotic", "antibiotics"],
    pattern: /\bantibiotic(?:s)?\b/i,
  },
  "action.metabolic_workup": {
    label: "Recommends metabolic evaluation (PTH/Ca/HCO3/urine studies)",
    synonyms: [
      "metabolic workup", "metabolic evaluation", "metabolic work-up",
      "check PTH", "check calcium", "serum bicarbonate", "urine pH", "24 hour urine"
    ],
    pattern: /\bmetabolic\s+(work-?up|evaluation)\b|check\s+(PTH|calcium|Ca|bicarbonate|urine\s+pH)|\b24\s*hour\s*urine\b/i
  },
  "action.nephrology_referral": {
    label: "Nephrology referral",
    synonyms: ["nephrology referral", "refer to nephrology"],
    pattern: /\b(nephrology)\s+referr(al|ed|ing)?\b|\brefer\s+to\s+nephrology\b/i
  },

  // ====== Diagnoses ======
  "dx.appendicitis": {
    label: "Acute appendicitis",
    synonyms: ["acute appendicitis", "appendicitis"],
    pattern: /\bacute\s+appendicitis\b|\bappendicitis\b/i,
  },
  "dx.medullary_nephrocalcinosis": {
    label: "Medullary nephrocalcinosis",
    synonyms: ["medullary nephrocalcinosis", "nephrocalcinosis"],
    pattern: /\bmedullary\s+nephrocalcinosis|\bnephrocalcinosis\b/i,
  },
  "dx.hepatic_abscess": {
    label: "Hepatic abscess",
    synonyms: ["hepatic abscess", "liver abscess", "pyogenic abscess"],
    pattern: /\b(hepatic|liver)\s+abscess\b/i,
  },
  "dx.cystic_metastases": {
    label: "Cystic or necrotic liver metastases",
    synonyms: ["cystic metastases", "necrotic metastases", "cystic liver metastases", "necrotic liver mets"],
    pattern: /\b(cystic|necrotic)\s+(liver\s+)?metastases?\b/i,
  },
  "dx.medullary_nephrocalcinosis": {
    label: "Medullary nephrocalcinosis",
    synonyms: ["medullary nephrocalcinosis", "nephrocalcinosis"],
    pattern: /\bmedullary\s+nephrocalcinosis\b|\bnephrocalcinosis\b/i
  },
  "dx.nephrolithiasis": {
    label: "Nephrolithiasis (stones)",
    synonyms: ["renal stone", "kidney stone", "nephrolithiasis", "urolithiasis", "calculi"],
    pattern: /\b(nephro|uro)?lithiasis\b|\b(renal|kidney)\s+stone(s)?\b|\bcalcul(us|i)\b/i
  },
  "dx.medullary_sponge_kidney": {
    label: "Medullary sponge kidney",
    synonyms: ["medullary sponge kidney", "MSK"],
    pattern: /\bmedullary\s+sponge\s+kidney\b|\bMSK\b/i
  },
  "dx.primary_hyperparathyroidism": {
    label: "Primary hyperparathyroidism",
    synonyms: ["primary hyperparathyroidism", "hyperparathyroidism"],
    pattern: /\b(primary\s+)?hyperparathyroidism\b|\bPTH\b/i
  },
  "dx.distal_RTA_type_1": {
    label: "Distal (type 1) renal tubular acidosis",
    synonyms: ["distal renal tubular acidosis", "distal RTA", "type 1 RTA"],
    pattern: /\b(distal\s+)?(renal\s+tubular\s+acidosis|RTA)\b|\btype\s*1\s*RTA\b/i
  },
  "dx.hypervitaminosis_D": {
    label: "Hypervitaminosis D",
    synonyms: ["hypervitaminosis D", "vitamin D excess", "vitamin D intoxication"],
    pattern: /\bhypervitaminosis\s*D\b|\bvitamin\s*D\s*(excess|intoxication)\b/i
  },
  "dx.sarcoidosis": {
    label: "Sarcoidosis",
    synonyms: ["sarcoidosis"],
    pattern: /\bsarcoidosis\b/i
  },
  
};

// Generic detector using pattern OR detect()
export function detectConcept(text, concept) {
  const t = text || "";
  if (concept.detect) return concept.detect(t);
  if (concept.pattern) {
    const m = t.match(concept.pattern);
    return m ? { hit: true, quote: m[0] } : { hit: false };
  }
  // fallback: synonyms
  const any = (concept.synonyms||[]).some(s => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\$&")}\\b`, 'i').test(t));
  return any ? { hit: true, quote: (concept.synonyms||[]).find(s=>t.match(new RegExp(`\\b${s.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\$&")}\\b`, 'i'))) } : { hit: false };
}

/* ========== (Helpers) only add if you don't already have these ========== */
function coOccurs(text, reA, reB, window = 90) {
  const t = (text || '').toLowerCase();
  const a = new RegExp(reA, 'gi');
  let m;
  while ((m = a.exec(t)) !== null) {
    const s = Math.max(0, m.index - window);
    const e = Math.min(t.length, m.index + m[0].length + window);
    if (new RegExp(reB, 'i').test(t.slice(s, e))) return true;
  }
  return false;
}

function isNegated(text, termRe, window = 40) {
  const NEG = /\b(no|without|absent|negative\s+for|denies?)\b/i;
  const t = text || '';
  const r = new RegExp(termRe, 'gi');
  let m;
  while ((m = r.exec(t)) !== null) {
    const s = Math.max(0, m.index - window);
    const scope = t.slice(s, m.index);
    if (NEG.test(scope)) return true;
  }
  return false;
}
