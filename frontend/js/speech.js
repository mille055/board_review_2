// Minimal adapter; later swap to AWS Transcribe
let recog=null, listening=false;
const transcriptEl = document.getElementById('vTranscript');
const micBtn = document.getElementById('vMicBtn');

if('webkitSpeechRecognition' in window || 'SpeechRecognition' in window){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recog = new SR(); recog.continuous=true; recog.interimResults=true; recog.lang='en-US';
  recog.onresult = (e)=>{
    let txt=''; for(const res of e.results){ txt += res[0].transcript; txt += res.isFinal?'\n':''; }
    transcriptEl.value = txt.trim();
    //transcriptEl.textContent = txt.trim();
  };
  recog.onend = ()=>{ listening=false; if(micBtn) micBtn.textContent='🎤 Start Demo Transcribe'; };
}

export function toggleMic(){
  if(!recog){ alert('Speech API not supported. For production, use AWS Transcribe.'); return; }
  if(!listening){ recog.start(); listening=true; micBtn.textContent='■ Stop'; }
  else { recog.stop(); }
}
// export function pasteTranscript(){
//   const txt = prompt("Paste or edit transcript text:");
//   if(txt!=null){ transcriptEl.textContent = txt.trim(); }
// }
export function getTranscript(){
  const el = document.getElementById('vTranscript');
  if (!el) return '';
  return (el.value || '').trim();
}
