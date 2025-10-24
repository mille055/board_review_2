const API_BASE = '';  // Nginx proxies this to the backend inside the container

export const CONFIG = {
  API_BASE: '', 
  CASES_URL: 'data/cases.json',     // later: /api/cases
  FEEDBACK_API: `api/feedback`,    // now points to backend
  MCQ_CHAT_API: `api/mcq/chat`,
  TRANSCRIBE: 'webspeech',          // 'webspeech' | 'aws'
  FEEDBACK_MODE: 'hybrid',         // 'llm' | 'heuristic | 'hybrid'
  // API_KEY: 'dev-123' 
};

export const SUBS = [
  "Neuroradiology","Musculoskeletal Radiology","Gastrointestinal Radiology","Genitourinary Radiology","Ultrasound",
  "Pediatric Radiology","Breast Imaging","Vascular & Interventional Radiology","Thoracic Radiology", "Physics"
];
