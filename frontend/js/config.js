export const CONFIG = {
  CASES_URL: 'data/cases.json',     // later: /api/cases
  FEEDBACK_API: '/api/feedback',    // placeholder for backend
  TRANSCRIBE: 'webspeech',          // 'webspeech' | 'aws'
  FEEDBACK_MODE: 'heuristic'         // 'llm' | 'heuristic | 'hybrid'
};

export const SUBS = [
  "Neuroradiology","Musculoskeletal Radiology","Gastrointestinal Radiology","Genitourinary Radiology",
  "Pediatric Radiology","Breast Imaging","Vascular & Interventional Radiology","Thoracic Radiology"
];
