const API_BASE = '/api';  // Nginx proxies this to the backend inside the container

export const CONFIG = {
  CASES_URL: 'data/cases.json',     // later: /api/cases
  FEEDBACK_API: `${API_BASE}/feedback`,    // now points to backend
  MCQ_CHAT_API: `${API_BASE}/mcq/chat`,
  TRANSCRIBE: 'webspeech',          // 'webspeech' | 'aws'
  FEEDBACK_MODE: 'hybrid',         // 'llm' | 'heuristic | 'hybrid'
  // API_KEY: 'dev-123' 
};

export const SUBS = [
  "Neuroradiology","Musculoskeletal Radiology","Gastrointestinal Radiology","Genitourinary Radiology","Ultrasound",
  "Pediatric Radiology","Breast Imaging","Vascular & Interventional Radiology","Thoracic Radiology", "Physics"
];
