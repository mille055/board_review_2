# app.py
import os, time, json, re
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any, Literal

from fastapi import FastAPI, HTTPException, Depends, Query, Request, Header
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel, EmailStr, Field
from passlib.context import CryptContext
from jose import jwt, JWTError

import logging
log = logging.getLogger("uvicorn.error")

# -----------------------------
# Optional Mongo support
# -----------------------------
USE_MONGO = bool(os.getenv("MONGO_URI"))
if USE_MONGO:
    import motor.motor_asyncio
    mongo_client = motor.motor_asyncio.AsyncIOMotorClient(os.getenv("MONGO_URI"))
    db = mongo_client.get_default_database()
else:
    _users: Dict[str, Dict[str, Any]] = {}
    _attempts: Dict[str, List[Dict[str, Any]]] = {}

# -----------------------------
# OpenAI (optional)
# -----------------------------
try:
    from openai import OpenAI
    openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
except Exception:
    openai_client = None
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# -----------------------------
# AWS S3 (optional)
# -----------------------------
import boto3
from botocore.config import Config as BotoConfig
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
S3_BUCKET = os.getenv("S3_BUCKET")
s3_client = boto3.client("s3", region_name=AWS_REGION, config=BotoConfig(signature_version="s3v4"))

# -----------------------------
# Auth / Security
# -----------------------------
SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
ALGO = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("JWT_TTL_MIN", "1440"))
ADMIN_EMAILS = {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}

# Auth modes: off | apikey | jwt (default)
# normalize so "api_key" and "apikey" both work
AUTH_MODE = os.getenv("AUTH_MODE", "jwt").lower().replace("_", "")
API_KEY = os.getenv("API_KEY", "")

# Password hashing (if you use /auth endpoints)
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
def hash_pw(p: str) -> str: return pwd_ctx.hash(p)
def verify_pw(p: str, h: str) -> bool: return pwd_ctx.verify(p, h)

def create_access_token(sub: str) -> str:
    payload = {"sub": sub, "exp": datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)}
    return jwt.encode(payload, SECRET, algorithm=ALGO)

def _decode_jwt(token: str) -> str:
    try:
        data = jwt.decode(token, SECRET, algorithms=[ALGO])
        sub = data.get("sub")
        if not sub:
            raise HTTPException(status_code=401, detail="Invalid token")
        return sub
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

async def current_identity(request: Request, x_api_key: str = Header(default=None)) -> str:
    # Let CORS preflight pass through without auth checks
    if request.method == "OPTIONS":
        return "preflight@cors"

    if AUTH_MODE == "off":
        return "demo@local"

    if AUTH_MODE == "apikey":
        if API_KEY and x_api_key == API_KEY:
            return "demo@apikey"
        raise HTTPException(status_code=401, detail="Invalid API key")

    # JWT mode (default)
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth or not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = auth.split(" ", 1)[1]
    return _decode_jwt(token)

def require_admin(email_or_identity: str):
    if ADMIN_EMAILS:
        if email_or_identity.lower() not in ADMIN_EMAILS:
            raise HTTPException(status_code=403, detail="Admin-only operation")

# -----------------------------
# FastAPI app + CORS
# -----------------------------
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Oral Boards Trainer API", version="0.3")

# CORS_ORIGIN can be a comma-separated list (e.g. "http://localhost:8080,http://127.0.0.1:8080")
_raw_origins = os.getenv("CORS_ORIGIN", "http://localhost:8080")
_allow_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]
_allow_credentials = _allow_origins != ["*"]  # credentials not allowed with wildcard origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    # Explicit list to avoid picky preflight handling on some Starlette versions:
    allow_headers=["Content-Type", "Authorization", "X-API-KEY", "x-api-key"],
)

# Optional request logs (shows preflight details)
@app.middleware("http")
async def log_requests(request: Request, call_next):
    log.info(
        ">>> %s %s origin=%s ACRM=%s ACRH=%s",
        request.method, request.url.path,
        request.headers.get("origin"),
        request.headers.get("access-control-request-method"),
        request.headers.get("access-control-request-headers"),
    )
    resp = await call_next(request)
    log.info("<<< %s %s %s", request.method, request.url.path, resp.status_code)
    return resp

# Friendly root & favicon
@app.get("/", include_in_schema=False)
def root(): return RedirectResponse("/docs")
@app.get("/favicon.ico", include_in_schema=False)
def favicon(): return Response(status_code=204)

# -----------------------------
# Models
# -----------------------------
class UserCreate(BaseModel):
    email: EmailStr
    password: str

class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"

class FeedbackIn(BaseModel):
    caseId: str
    boardPrompt: Optional[str] = None
    expectedAnswer: Optional[str] = None
    rubric: List[str] = []
    transcript: str
    heuristic: Dict[str, Any] = {}

class FeedbackOut(BaseModel):
    feedback: str
    score: Dict[str, Any] = {}

# ---- MCQ Chat models ----
class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = ""

class MCQChatRequest(BaseModel):
    # All optional for robustness (prevents 422)
    mode: Optional[str] = "mcq_chat"
    caseId: Optional[str] = None
    title: Optional[str] = None
    subspecialty: Optional[str] = None
    boardPrompt: Optional[str] = None
    expectedAnswer: Optional[str] = None

    question: Optional[str] = None
    choices: List[str] = []
    selected: List[str] = []

    # rolling chat history
    messages: List[ChatTurn] = []

class MCQChatResponse(BaseModel):
    reply: str

class AttemptIn(BaseModel):
    caseId: str
    subspecialty: str
    similarity: float
    rubricHit: int
    rubricTotal: int
    letter: str

class AttemptRow(BaseModel):
    ts: int = Field(default_factory=lambda: int(time.time()*1000))
    caseId: str
    subspecialty: str = "Unknown"
    similarity: float = 0.0
    rubricHit: int = 0
    rubricTotal: int = 0
    letter: str = ""

class ProgressOut(BaseModel):
    reviewedCount: int
    per: Dict[str, Any]

class Case(BaseModel):
    id: str = Field(..., description="Unique case ID, e.g. gi-001")
    title: str
    subspecialty: str
    tags: List[str] = []
    images: List[str] = []
    boardPrompt: Optional[str] = None
    expectedAnswer: Optional[str] = None
    rubric: List[str] = []

class UpsertResult(BaseModel):
    ok: bool
    id: str

# -----------------------------
# Persistence helpers
# -----------------------------
async def get_user(email: str) -> Optional[Dict[str, Any]]:
    if USE_MONGO:
        return await db.users.find_one({"email": email})
    return _users.get(email)

async def create_user(email: str, password: str):
    record = {"email": email, "password_hash": hash_pw(password), "createdAt": int(time.time()*1000)}
    if USE_MONGO:
        await db.users.insert_one(record)
    else:
        _users[email] = record

async def insert_attempt(identity: str, a: Dict[str, Any]):
    a["user"] = identity
    a["ts"] = int(time.time()*1000)
    if USE_MONGO:
        await db.attempts.insert_one(a)
    else:
        _attempts.setdefault(identity, []).append(a)

async def list_attempts(identity: str) -> List[Dict[str, Any]]:
    if USE_MONGO:
        return await db.attempts.find({"user": identity}).sort("ts", 1).to_list(length=10000)
    return _attempts.get(identity, [])

async def clear_attempts(identity: str):
    if USE_MONGO:
        await db.attempts.delete_many({"user": identity})
    else:
        _attempts[identity] = []

CASES_PATH = os.getenv("CASES_JSON", os.path.join(os.path.dirname(__file__), "../frontend/data/cases.json"))

def _read_cases_file() -> List[Dict[str, Any]]:
    try:
        with open(CASES_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return []

def _write_cases_file(items: List[Dict[str, Any]]):
    os.makedirs(os.path.dirname(CASES_PATH), exist_ok=True)
    with open(CASES_PATH, "w") as f:
        json.dump(items, f, indent=2)

def _split_expected_answer(expected: Optional[str]) -> Dict[str, str]:
    """Parse 'Diagnosis: ... Key: ... Differential: ... Management: ...' into a dict."""
    if not expected:
        return {}
    blocks: Dict[str, str] = {}
    for key in ("Diagnosis", "Key", "Differential", "Management"):
        m = re.search(
            rf"{key}\s*:\s*(.+?)(?=(Diagnosis|Key|Differential|Management)\s*:|$)",
            expected, re.IGNORECASE | re.DOTALL
        )
        if m:
            blocks[key.lower()] = m.group(1).strip()
    return blocks

def _guess_relevant_choices(choices: List[str], expected: Optional[str]) -> List[str]:
    if not choices or not expected:
        return []
    blocks = _split_expected_answer(expected)
    needle = " ".join([blocks.get("diagnosis", ""), blocks.get("key", "")]).lower()
    words = {w for w in re.findall(r"[a-z0-9]+", needle) if len(w) >= 5}
    scored = []
    for ch in choices:
        cw = set(re.findall(r"[a-z0-9]+", ch.lower()))
        overlap = len(cw & words)
        scored.append((overlap, ch))
    scored.sort(reverse=True)
    return [c for s, c in scored if s > 0][:2]

def _build_coach_reply(req: "MCQChatRequest") -> str:
    blocks = _split_expected_answer(req.expectedAnswer)
    diag  = blocks.get("diagnosis")
    keys  = blocks.get("key")
    mgmt  = blocks.get("management")
    diff  = blocks.get("differential")

    lines: List[str] = []
    if req.question:
        lines.append(f"**Question focus:** {req.question}")
    if req.boardPrompt:
        lines.append(f"**Clinical context:** {req.boardPrompt}")
    if keys:
        lines.append(f"**Key imaging cues:** {keys}")
    if diag:
        lines.append(f"**Likely diagnosis:** {diag}")
    if diff:
        lines.append(f"**Close differential:** {diff}")

    if req.choices:
        best = _guess_relevant_choices(req.choices, req.expectedAnswer)
        if best:
            lines.append(f"**Choices that fit the pattern:** {', '.join(best)}")
    if req.selected:
        lines.append(f"**Your selection:** {', '.join(req.selected)}")
        if mgmt:
            lines.append(f"**Management considerations:** {mgmt}")

    # gentle prompt to keep the chat going
    if not req.messages or (req.messages and req.messages[-1].role != "user"):
        lines.append("What would you like to explore—diagnostic criteria, differentials, or management?")
    return "\n".join(lines)

# -----------------------------
# Routes
# -----------------------------
@app.get("/api/health")
def health():
    return {"ok": True, "mongo": USE_MONGO, "authMode": AUTH_MODE, "model": OPENAI_MODEL}

# Auth (JWT helpers still available even if AUTH_MODE != jwt)
@app.post("/api/auth/register", response_model=TokenOut)
async def register(body: UserCreate):
    if await get_user(body.email):
        raise HTTPException(400, "User already exists")
    await create_user(body.email, body.password)
    token = create_access_token(body.email)
    return TokenOut(access_token=token)

@app.post("/api/auth/login", response_model=TokenOut)
async def login(form: OAuth2PasswordRequestForm = Depends()):
    email = form.username
    user = await get_user(email)
    if not user or not verify_pw(form.password, user["password_hash"]):
        raise HTTPException(401, "Invalid credentials")
    token = create_access_token(email)
    return TokenOut(access_token=token)

@app.get("/api/me")
async def me(identity: str = Depends(current_identity)):
    return {"identity": identity, "isAdmin": (not ADMIN_EMAILS) or (identity.lower() in ADMIN_EMAILS)}

# Cases — list/fetch/upsert/delete
@app.get("/api/cases", response_model=List[Case])
async def list_cases(examMode: bool = False):
    if USE_MONGO:
        cur = db.cases.find({})
        items = await cur.to_list(length=100000)
    else:
        items = _read_cases_file()
    items.sort(key=lambda x: x.get("id",""))
    if examMode:
        for it in items:
            it.pop("expectedAnswer", None)
            it.pop("rubric", None)
    return items

@app.get("/api/cases/{case_id}", response_model=Case)
async def get_case(case_id: str):
    if USE_MONGO:
        doc = await db.cases.find_one({"id": case_id})
        if not doc: raise HTTPException(404, "Not found")
        return doc
    else:
        for it in _read_cases_file():
            if it.get("id") == case_id:
                return it
        raise HTTPException(404, "Not found")

@app.post("/api/cases", response_model=UpsertResult)
async def upsert_case(body: Case, identity: str = Depends(current_identity)):
    require_admin(identity)
    if USE_MONGO:
        await db.cases.update_one({"id": body.id}, {"$set": body.dict()}, upsert=True)
        return UpsertResult(ok=True, id=body.id)
    else:
        items = _read_cases_file()
        idx = next((i for i,x in enumerate(items) if x.get("id")==body.id), -1)
        if idx >= 0: items[idx] = body.dict()
        else: items.append(body.dict())
        _write_cases_file(items)
        return UpsertResult(ok=True, id=body.id)

@app.delete("/api/cases/{case_id}")
async def delete_case(case_id: str, identity: str = Depends(current_identity)):
    require_admin(identity)
    if USE_MONGO:
        res = await db.cases.delete_one({"id": case_id})
        if res.deleted_count == 0: raise HTTPException(404, "Not found")
        return {"ok": True}
    else:
        items = _read_cases_file()
        n = len(items)
        items = [x for x in items if x.get("id") != case_id]
        if len(items) == n:
            raise HTTPException(404, "Not found")
        _write_cases_file(items)
        return {"ok": True}

# Feedback (LLM)
@app.post("/api/mcq/chat", response_model=MCQChatResponse)
async def mcq_chat(body: MCQChatRequest, identity: str = Depends(current_identity)):
    """
    Conversational endpoint about the current MCQ. 
    Works without OpenAI (deterministic coach), 
    and uses your OpenAI client automatically if OPENAI_API_KEY is set.
    """
    system = (
        "You are an expert radiology boards coach. "
        "Use the case context and question to provide concise, high-yield teaching. "
        "Contrast the best answer with top distractors when useful."
    )

    # If you have OPENAI_API_KEY configured, try the model first
    if openai_client and os.getenv("OPENAI_API_KEY"):
        try:
            msgs = [{"role": "system", "content": system}]
            # Seed the conversation with compact context (first turn)
            context_blob = (
                f"CASE: {body.title or ''} [{body.subspecialty or ''}]\n"
                f"CONTEXT: {body.boardPrompt or ''}\n"
                f"EXPECTED: {body.expectedAnswer or ''}\n"
                f"QUESTION: {body.question or ''}\n"
                f"CHOICES: {', '.join(body.choices or [])}\n"
                f"SELECTED: {', '.join(body.selected or [])}\n"
                "--------"
            )
            msgs.append({"role": "user", "content": context_blob})

            # Then any rolling chat history
            for t in body.messages or []:
                msgs.append({"role": t.role, "content": t.content or ""})

            # If user hasn't asked anything yet, nudge an initial explanation
            if not any(t.role == "user" for t in body.messages or []):
                msgs.append({"role": "user", "content": "Briefly explain the best answer and key pitfalls."})

            resp = openai_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=msgs,
                temperature=0.2,
                max_tokens=600,
            )
            text = (resp.choices[0].message.content or "").strip()
            if text:
                return MCQChatResponse(reply=text)
        except Exception as e:
            log.exception("MCQ chat LLM error: %s", e)

    # Fallback: deterministic coach (no external LLM required)
    return MCQChatResponse(reply=_build_coach_reply(body))

@app.post("/api/feedback", response_model=FeedbackOut)
async def feedback(body: FeedbackIn, identity: str = Depends(current_identity)):
    log.info("FEEDBACK by %s case=%s transcript_len=%d rubric=%d",
             identity, body.caseId, len(body.transcript or ""), len(body.rubric or []))
    system = "You are an expert radiology oral-boards examiner. Be precise, supportive, and clinically grounded."
    user = f"""CASE SUMMARY:
{body.boardPrompt or ''}

EXPECTED ANSWER:
{body.expectedAnswer or ''}

RUBRIC:
- """ + "\n- ".join(body.rubric or []) + f"""

TRAINEE TRANSCRIPT:
{body.transcript}

HEURISTIC (FYI):
{json.dumps(body.heuristic)}
----
Respond with:
1) What was done well.
2) Specific gaps or incorrect statements.
3) Rubric mapping (hit/miss with one-line rationale each).
4) 2–3 sentence coaching paragraph.
"""
    if openai_client and os.getenv("OPENAI_API_KEY"):
        try:
            log.info("LLM call model=%s", OPENAI_MODEL)
            resp = openai_client.chat.completions.create(
                model=OPENAI_MODEL,
                messages=[{"role":"system","content":system},{"role":"user","content":user}],
                temperature=0.2,
            )
            feedback_text = resp.choices[0].message.content
            log.info("LLM ok: %d chars", len(feedback_text or ""))
        except Exception as e:
            log.exception("LLM error")
            feedback_text = f"(LLM error: {e})\n\nBased on the rubric and transcript, lead clearly with diagnosis, list key findings, discuss complications, and state management."
    else:
        log.info("LLM disabled (missing client or OPENAI_API_KEY)")
        feedback_text = "LLM disabled. Set OPENAI_API_KEY to enable model feedback."
    return FeedbackOut(feedback=feedback_text, score=body.heuristic or {})

# Attempts / Progress
@app.post("/api/attempt")
async def add_attempt(a: AttemptIn, identity: str = Depends(current_identity)):
    await insert_attempt(identity, a.dict())
    return {"ok": True}

@app.get("/api/progress/attempts", response_model=List[AttemptRow])
async def get_progress_attempts(identity: str = Depends(current_identity)):
    rows = await list_attempts(identity)
    out = []
    for r in rows:
        out.append({
            "ts": int(r.get("ts") or time.time()*1000),
            "caseId": r.get("caseId", ""),
            "subspecialty": r.get("subspecialty", "Unknown"),
            "similarity": float(r.get("similarity", 0.0)),
            "rubricHit": int(r.get("rubricHit", 0)),
            "rubricTotal": int(r.get("rubricTotal", 0)),
            "letter": r.get("letter", "")
        })
    return out

@app.get("/api/progress", response_model=ProgressOut)
async def get_progress(identity: str = Depends(current_identity)):
    rows = await list_attempts(identity)
    reviewed = len({r["caseId"] for r in rows})
    per: Dict[str, Any] = {}
    for r in rows:
        sub = r.get("subspecialty", "Unknown")
        p = per.setdefault(sub, {"attempts": 0, "meanSim": 0.0, "hits": 0, "total": 0})
        p["attempts"] += 1
        p["meanSim"] += r.get("similarity", 0.0)
        p["hits"]    += r.get("rubricHit", 0)
        p["total"]   += r.get("rubricTotal", 0)
    for sub, p in per.items():
        if p["attempts"]:
            p["meanSim"] = round((p["meanSim"] / p["attempts"]) * 100)
        p["meanRubric"] = round((p["hits"] / p["total"]) * 100) if p["total"] else 0
        p.pop("hits"); p.pop("total")
    return ProgressOut(reviewedCount=reviewed, per=per)

@app.post("/api/progress/clear")
async def clear_progress(identity: str = Depends(current_identity)):
    await clear_attempts(identity)
    return {"ok": True}

# --- S3 presign ---
_KEY_RE = re.compile(r"^[a-zA-Z0-9/_\-.]+$")

ALLOWED_PUT_CT = {
    "image/png",
    "image/jpeg",
    "image/jpg",
    "application/dicom",
    "application/dicom+json",
    "application/octet-stream",
}

@app.get("/api/s3/presign")
async def s3_presign(
    op: str = Query(..., regex="^(put|get)$"),
    key: str = Query(..., description="S3 object key, e.g. cases/gi-001/images/axial1.png"),
    contentType: Optional[str] = Query(None, description="Required for PUT"),
    expiresSec: int = Query(900, ge=60, le=3600),
    identity: str = Depends(current_identity)
):
    require_admin(identity)

    if not S3_BUCKET:
        raise HTTPException(400, "S3_BUCKET not configured")
    if not _KEY_RE.match(key) or ".." in key:
        raise HTTPException(400, "Invalid key")
    if not key.startswith(("cases/", "uploads/")):
        raise HTTPException(400, "Key must start with 'cases/' or 'uploads/'")

    if op == "put":
        if not contentType:
            raise HTTPException(400, "contentType required for PUT")
        if contentType not in ALLOWED_PUT_CT:
            raise HTTPException(400, f"contentType not allowed: {contentType}")
        try:
            url = s3_client.generate_presigned_url(
                ClientMethod="put_object",
                Params={"Bucket": S3_BUCKET, "Key": key, "ContentType": contentType},
                ExpiresIn=expiresSec
            )
        except Exception as e:
            raise HTTPException(500, f"S3 error: {e}")
        return {"url": url, "method": "PUT", "headers": {"Content-Type": contentType}}

    else:  # get
        try:
            url = s3_client.generate_presigned_url(
                ClientMethod="get_object",
                Params={"Bucket": S3_BUCKET, "Key": key},
                ExpiresIn=expiresSec
            )
        except Exception as e:
            raise HTTPException(500, f"S3 error: {e}")
        return {"url": url, "method": "GET"}
