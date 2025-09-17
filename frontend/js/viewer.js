// Canvas + Video viewer: zoom/pan/brightness/contrast + image/video thumbs
let currentCase = null, currentIdx = 0, assets = [];
let scale=1, panX=0, panY=0, bright=0, cont=0, isPanning=false, startX=0, startY=0, img=null, rawImg=null;

let videoEl = null;            // created on demand
let canvasPlaceholder = null;  // where the canvas was when we swap it out

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

// ----- canvas for still images -----
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

// Controls (kept visible)
const zoomInput   = document.getElementById('zoom');
const brightInput = document.getElementById('brightness');
const contInput   = document.getElementById('contrast');

// ---------- helpers ----------
function isVideoSrc(src){ return /\.(mp4|webm|ogg)$/i.test(src||''); }
function getAssets(caseObj){
  if (Array.isArray(caseObj.media) && caseObj.media.length){
    return caseObj.media.map(m => ({
      type: m.type || (isVideoSrc(m.src) ? 'video' : 'image'),
      src: m.src,
      poster: m.poster || null,
      caption: m.caption || '',
      autoplay: m.autoplay !== false,  // default true
      loop: m.loop !== false,          // default true
      muted: m.muted !== false         // default true
    }));
  }
  // legacy fallback: images[]
  return (caseObj.images||[]).map(src => ({
    type: isVideoSrc(src) ? 'video' : 'image',
    src, poster: null, caption: '', autoplay: true, loop: true, muted: true
  }));
}

// --- Pan behavior for video ---
const PAN_VIDEO_WITH_MODIFIER_ONLY = false; // set to false to also allow left-drag above the controls bar
const VIDEO_CONTROLS_HEIGHT_GUESS = 56;    // px; rough height of native controls bar

function shouldPanVideo(e){
  // Option A: require a modifier or non-left button (recommended to avoid any scrub conflicts)
  if (PAN_VIDEO_WITH_MODIFIER_ONLY) {
    return e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.button === 1 || e.button === 2;
  }
  // Option B: allow left-drag for pan only if you're NOT on the controls bar area
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.button === 1 || e.button === 2) return true;
  const r = videoEl?.getBoundingClientRect();
  if (!r) return false;
  // don't pan if starting within the bottom controls band
  return e.clientY < (r.bottom - VIDEO_CONTROLS_HEIGHT_GUESS);
}

function isCurrentVideo(){
  return !!(assets.length && assets[currentIdx] && assets[currentIdx].type === 'video');
}

function updateControlStates(){
  const isVid = isCurrentVideo();
  if (zoomInput){
    // Zoom works for both images and videos
    zoomInput.disabled = false;
    zoomInput.classList.toggle('opacity-50', false);
    zoomInput.classList.toggle('pointer-events-none', false);
  }
  if (brightInput){
    brightInput.disabled = isVid; // image-only WL
    brightInput.classList.toggle('opacity-50', isVid);
    brightInput.classList.toggle('pointer-events-none', isVid);
  }
  if (contInput){
    contInput.disabled = isVid;   // image-only WL
    contInput.classList.toggle('opacity-50', isVid);
    contInput.classList.toggle('pointer-events-none', isVid);
  }
}

// ---------- video mount/unmount (swap in place of canvas) ----------
function ensureVideoEl(){
  if (videoEl) return videoEl;
  videoEl = document.createElement('video');
  videoEl.id = 'videoEl';
  videoEl.controls = true;
  videoEl.playsInline = true;
  videoEl.preload = 'metadata';
  // Fit where the canvas sits (inherits parent layout)
  Object.assign(videoEl.style, {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    background: '#000',
    display: 'block',
    transformOrigin: '50% 50%', // center for cleaner zoom/pan
    willChange: 'transform'
  });

  // video interactions: pan on drag, dblclick to reset
  videoEl.addEventListener('mousedown', (e)=>{
    if (!isCurrentVideo()) return;
    if (!shouldPanVideo(e)) {
    // let the native controls (timeline scrubber, volume, etc.) handle it
      return;
    }
  e.preventDefault();
  isPanning = true;
  startX = e.clientX - panX;
  startY = e.clientY - panY;
});
  videoEl.addEventListener('dblclick', ()=>{
    if (!isCurrentVideo()) return;
    resetView(); applyVideoTransform();
  });

  return videoEl;
}

function mountVideoInPlace(){
  if (!canvasPlaceholder) canvasPlaceholder = document.createComment('canvas-placeholder');
  const parent = canvas.parentNode;
  if (!parent) return;
  // Replace the canvas with the video element
  parent.insertBefore(canvasPlaceholder, canvas);
  parent.replaceChild(ensureVideoEl(), canvas);
  applyVideoTransform(); // ensure current pan/zoom applied
}

function restoreCanvasInPlace(){
  if (!canvasPlaceholder) return;
  const parent = canvasPlaceholder.parentNode;
  if (!parent) return;
  // Replace the video with the original canvas node
  if (videoEl && videoEl.parentNode === parent) {
    parent.replaceChild(canvas, videoEl);
  } else {
    parent.replaceChild(canvas, canvasPlaceholder);
  }
  // Keep placeholder for next swap
}

// ---------- public API ----------
export function openViewer(caseObj){
  currentCase = caseObj; currentIdx=0; assets = getAssets(caseObj);

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

  // Build thumbs (image or video)
  vThumbs.innerHTML='';
  assets.forEach((a,i)=>{
    const t = document.createElement('div');
    t.className = 'thumb';
    const imgEl = document.createElement('img');

    if (a.type === 'image') {
      imgEl.src = a.src;
    } else {
      imgEl.src = a.poster || 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60"><rect width="80" height="60" fill="#222"/><polygon points="30,20 58,30 30,40" fill="#fff"/></svg>'
      );
      const badge = document.createElement('span');
      badge.textContent = '▶';
      badge.className = 'thumb-badge';
      t.appendChild(badge);
    }
    if(i===0) t.classList.add('active');
    imgEl.alt = a.caption || (a.type === 'video' ? 'video' : 'image');
    t.appendChild(imgEl);
    t.onclick = ()=>{ currentIdx=i; selectThumb(); loadAsset(); };
    vThumbs.appendChild(t);
  });

  resetView();
  viewer.classList.add('show');
  loadAsset();
}

export function closeViewer(){ stopVideo(); viewer.classList.remove('show'); }

export function nextImage(){
  if(!currentCase || !assets.length) return;
  currentIdx = (currentIdx+1) % assets.length;
  loadAsset();
}
export function prevImage(){
  if(!currentCase || !assets.length) return;
  currentIdx = (currentIdx-1+assets.length) % assets.length;
  loadAsset();
}

export function setZoom(v){
  if(!assets.length) return;
  scale = parseFloat(v);
  if (isCurrentVideo()) {
    applyVideoTransform();
  } else if (assets[currentIdx].type==='image') {
    draw();
  }
}

export function setWL({brightness, contrast}){
  if(!assets.length) return;
  if (isCurrentVideo()) {
    // WL not applied to videos (kept disabled). If you decide to support:
    // videoEl.style.filter = `brightness(${brightnessMap}) contrast(${contrastMap})`;
    return;
  }
  // image mode
  bright=brightness; cont=contrast; (async()=>{
    img = await toProcessed(rawImg, bright, cont);
    draw();
  })();
}

export function resetView(){
  scale=1; panX=0; panY=0; bright=0; cont=0;
  if (isCurrentVideo()) applyVideoTransform();
}

// ---------- internal UI ----------
function selectThumb(){ [...vThumbs.children].forEach((ch,i)=>ch.classList.toggle('active', i===currentIdx)); }

function fitCanvas(){
  // Match internal pixel size to CSS box
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
}

function draw(){
  fitCanvas();
  ctx.save();
  ctx.fillStyle='#000'; ctx.fillRect(0,0,canvas.width,canvas.height);
  if(!img) { ctx.restore(); return; }
  const vw = canvas.clientWidth, vh = canvas.clientHeight;
  const iw = img.width, ih = img.height;
  const cx = vw/2 + panX, cy = vh/2 + panY;
  const sw = iw * scale, sh = ih * scale;
  ctx.translate(cx, cy); ctx.drawImage(img, -sw/2, -sh/2, sw, sh);
  ctx.restore();
}

function applyVideoTransform(){
  if (!videoEl) return;
  // translate in CSS pixels, scale uniform
  videoEl.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
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

function loadImg(src){ return new Promise((res,rej)=>{ const im=new Image(); im.crossOrigin='anonymous'; im.onload=()=>res(im); im.onerror=rej; im.src=src; }); }

// ---------- video helpers ----------
function stopVideo(){
  if (videoEl){ try { videoEl.pause(); } catch(_){} }
}

// ---------- main loader ----------
async function loadAsset(){
  if(!currentCase || !assets.length) return;
  const a = assets[currentIdx];

  updateControlStates();
  selectThumb();

  if (a.type === 'video'){
    // VIDEO MODE: swap the canvas out and put the video exactly in its place
    stopVideo();
    mountVideoInPlace();
    const v = ensureVideoEl();
    v.src = a.src;
    v.loop = a.loop ?? true;
    v.muted = a.muted ?? true;
    if (a.poster) v.poster = a.poster; else v.removeAttribute('poster');
    applyVideoTransform(); // apply current pan/zoom
    // best-effort autoplay (will show controls if blocked)
    v.addEventListener('canplay', () => { if (a.autoplay !== false) v.play().catch(()=>{}); }, { once:true });
    return;
  }

  // IMAGE MODE: ensure the canvas is back in its original spot
  restoreCanvasInPlace();

  img = null; rawImg = null;
  try {
    rawImg = await loadImg(a.src);
    img = await toProcessed(rawImg, bright, cont);
    draw();
  } catch(e) {
    console.error('Image load error', e);
  }
}

// ---------- interactions ----------
canvas.addEventListener('mousedown', (e)=>{
  if(!assets.length || assets[currentIdx].type!=='image') return;
  isPanning=true; startX=e.clientX-panX; startY=e.clientY-panY;
});
window.addEventListener('mouseup', ()=>{ isPanning=false; });
window.addEventListener('mousemove', (e)=>{
  if (!isPanning || !assets.length) return;
  panX = e.clientX-startX; panY = e.clientY-startY;
  if (isCurrentVideo()) applyVideoTransform();
  else if (assets[currentIdx].type==='image') draw();
});
canvas.addEventListener('dblclick', ()=>{
  if(!assets.length || assets[currentIdx].type!=='image') return;
  resetView(); loadAsset();
});

// keyboard + nav
document.addEventListener('keydown', (e)=>{
  if(!viewer.classList.contains('show')) return;
  if(e.key==='ArrowRight') nextImage();
  if(e.key==='ArrowLeft') prevImage();
  if(e.key===' ') e.preventDefault();
});

// buttons + sliders
document.getElementById('closeViewer').onclick = closeViewer;
document.getElementById('nextImg').onclick = nextImage;
document.getElementById('prevImg').onclick = prevImage;
zoomInput?.addEventListener('input', e=> setZoom(e.target.value));
brightInput?.addEventListener('input', e=> setWL({brightness:parseInt(e.target.value,10), contrast:cont}));
contInput?.addEventListener('input', e=> setWL({brightness:bright, contrast:parseInt(e.target.value,10)}));
