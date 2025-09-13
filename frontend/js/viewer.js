// Canvas viewer: zoom/pan/brightness/contrast + image thumbs
let currentCase = null, currentIdx = 0;
let scale=1, panX=0, panY=0, bright=0, cont=0, isPanning=false, startX=0, startY=0, img=null, rawImg=null;

const viewer = document.getElementById('viewer');
const vTitle = document.getElementById('vTitle');
const vMeta = document.getElementById('vMeta');
const vThumbs = document.getElementById('vThumbs');
const vBoardPrompt = document.getElementById('vBoardPrompt');
const vAns = document.getElementById('vAnswer');
const vRubric = document.getElementById('vRubric');
const vTranscript = document.getElementById('vTranscript');
const vFeedback   = document.getElementById('vFeedback');
const vScore      = document.getElementById('vScore');
const vLLM        = document.getElementById('vLLM');

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d',{willReadFrequently:true});

export function openViewer(caseObj){
  currentCase = caseObj; currentIdx=0;

  // Clear transcript + feedback from previous case
  if (vTranscript) vTranscript.textContent = '';
  if (vFeedback)   vFeedback.textContent   = '';
  if (vScore)      vScore.textContent      = '–';
  if (vLLM)        vLLM.textContent        = '';
  
  vTitle.textContent = caseObj.title;
  vMeta.textContent = caseObj.subspecialty || '';
  vBoardPrompt.textContent = caseObj.boardPrompt || '(no prompt)';
  vAns.textContent = caseObj.expectedAnswer || '(no expected answer)';
  vRubric.textContent = Array.isArray(caseObj.rubric)&&caseObj.rubric.length
    ? caseObj.rubric.map((r,i)=>`${i+1}. ${r}`).join('\n')
    : '(no rubric)';

  vThumbs.innerHTML='';
  (caseObj.images||[]).forEach((src,i)=>{
    const t = document.createElement('img');
    t.src = src; if(i===0) t.classList.add('active');
    t.onclick = ()=>{ currentIdx=i; selectThumb(); loadImage(); };
    vThumbs.appendChild(t);
  });

  resetView();
  viewer.classList.add('show');
  loadImage();
}

export function closeViewer(){ viewer.classList.remove('show'); }

function selectThumb(){ [...vThumbs.children].forEach((ch,i)=>ch.classList.toggle('active', i===currentIdx)); }

function fitCanvas(){
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
}
function draw(){
  fitCanvas();
  ctx.save();
  ctx.fillStyle='#000'; ctx.fillRect(0,0,canvas.width,canvas.height);
  if(!img) return;
  const vw = canvas.clientWidth, vh = canvas.clientHeight;
  const iw = img.width, ih = img.height;
  const cx = vw/2 + panX, cy = vh/2 + panY;
  const sw = iw * scale, sh = ih * scale;
  ctx.translate(cx, cy); ctx.drawImage(img, -sw/2, -sh/2, sw, sh);
  ctx.restore();
}

function clamp(v){ return v<0?0:(v>255?255:v); }
async function toProcessed(image, b, c){
  const off = document.createElement('canvas'); off.width=image.naturalWidth; off.height=image.naturalHeight;
  const ictx = off.getContext('2d'); ictx.drawImage(image,0,0);
  const d = ictx.getImageData(0,0,off.width,off.height); const data = d.data;
  const B = b/100 * 128;
  const factor = (259*(c+100))/(255*(100-c));
  for(let i=0;i<data.length;i+=4){
    data[i]   = clamp(factor*(data[i]-128)+128 + B);
    data[i+1] = clamp(factor*(data[i+1]-128)+128 + B);
    data[i+2] = clamp(factor*(data[i+2]-128)+128 + B);
  }
  ictx.putImageData(d,0,0);
  const out = new Image(); out.src = off.toDataURL('image/png'); await out.decode(); return out;
}

function load(src){ return new Promise((res,rej)=>{ const im=new Image(); im.crossOrigin='anonymous'; im.onload=()=>res(im); im.onerror=rej; im.src=src; }); }
async function loadImage(){
  if(!currentCase) return;
  const src = currentCase.images[currentIdx];
  rawImg = await load(src); img = await toProcessed(rawImg, bright, cont); draw();
}

export function nextImage(){ if(!currentCase) return; currentIdx = (currentIdx+1) % currentCase.images.length; selectThumb(); loadImage(); }
export function prevImage(){ if(!currentCase) return; currentIdx = (currentIdx-1+currentCase.images.length) % currentCase.images.length; selectThumb(); loadImage(); }

export function setZoom(v){ scale = parseFloat(v); draw(); }
export function setWL({brightness, contrast}){ bright=brightness; cont=contrast; (async()=>{ img = await toProcessed(rawImg, bright, cont); draw(); })(); }
export function resetView(){ scale=1; panX=0; panY=0; bright=0; cont=0; }

canvas.addEventListener('mousedown', (e)=>{ isPanning=true; startX=e.clientX-panX; startY=e.clientY-panY; });
window.addEventListener('mouseup', ()=>{ isPanning=false; });
window.addEventListener('mousemove', (e)=>{ if(!isPanning) return; panX = e.clientX-startX; panY = e.clientY-startY; draw(); });
canvas.addEventListener('dblclick', ()=>{ resetView(); loadImage(); });

document.addEventListener('keydown', (e)=>{
  if(!viewer.classList.contains('show')) return;
  if(e.key==='ArrowRight') nextImage();
  if(e.key==='ArrowLeft') prevImage();
  if(e.key===' ') e.preventDefault();
});

document.getElementById('closeViewer').onclick = closeViewer;
document.getElementById('nextImg').onclick = nextImage;
document.getElementById('prevImg').onclick = prevImage;
document.getElementById('zoom').addEventListener('input', e=> setZoom(e.target.value));
document.getElementById('brightness').addEventListener('input', e=> setWL({brightness:parseInt(e.target.value,10), contrast:cont}));
document.getElementById('contrast').addEventListener('input', e=> setWL({brightness:bright, contrast:parseInt(e.target.value,10)}));
