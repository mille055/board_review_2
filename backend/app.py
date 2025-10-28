# app.py
import os, time, json, re
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Dict, Any, Literal

from fastapi import FastAPI, HTTPException, Depends, Query, Request, Header, UploadFile, File, Form
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
# Support both S3_BUCKET_NAME (local .env) and S3_BUCKET (AWS App Runner)
S3_BUCKET = os.getenv("S3_BUCKET_NAME") or os.getenv("S3_BUCKET")
s3_client = boto3.client("s3", region_name=AWS_REGION, config=BotoConfig(signature_version="s3v4"))

# -----------------------------
# Auth / Security
# -----------------------------
SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
ALGO = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("JWT_TTL_MIN", "1440"))
ADMIN_EMAILS = {e.strip().lower() for e in os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()}

# Auth modes: off | apikey | jwt (default)
AUTH_MODE = os.getenv("AUTH_MODE", "jwt").lower().replace("_", "")
API_KEY = os.getenv("API_KEY", "")

# Password hashing
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
def hash_pw(p: str) -> str: return pwd_ctx.hash(p)
def verify_pw(p: str, h: str) -> bool: return pwd_ctx.verify(p, h)

def create_access_token(sub: str) -> str:
    payload = {"sub": sub, "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)}
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
    if request.method == "OPTIONS":
        return "preflight@cors"

    if AUTH_MODE == "off":
        return "demo@local"

    if AUTH_MODE == "apikey":
        if API_KEY and x_api_key == API_KEY:
            return "demo@apikey"
        raise HTTPException(status_code=401, detail="Invalid API key")

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

_raw_origins = os.getenv("CORS_ORIGIN", "http://localhost:8080")
_allow_origins = [o.strip() for o in _raw_origins.split(",") if o.strip()]
_allow_credentials = _allow_origins != ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    allow_headers=["Content-Type", "Authorization", "X-API-KEY", "x-api-key"],
)

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

@app.get("/", include_in_schema=False)
def root(): return RedirectResponse("/docs")
@app.get("/favicon.ico", include_in_schema=False)
def favicon(): return Response(status_code=204)

# # -----------------------------
# # Models
# # -----------------------------
# class UserCreate(BaseModel):
#     email: EmailStr
#     password: str

# class TokenOut(BaseModel):
#     access_token: str
#     token_type: str = "bearer"

# class FeedbackIn(BaseModel):
#     caseId: str
#     boardPrompt: Optional[str] = None
#     expectedAnswer: Optional[str] = None
#     rubric: List[str] = []
#     transcript: str
#     heuristic: Dict[str, Any] = {}

# class FeedbackOut(BaseModel):
#     feedback: str
#     score: Dict[str, Any] = {}

# class ChatTurn(BaseModel):
#     role: Literal["user", "assistant"]
#     content: str = ""

# class MCQChatRequest(BaseModel):
#     mode: Optional[str] = "mcq_chat"
#     caseId: Optional[str] = None
#     title: Optional[str] = None
#     subspecialty: Optional[str] = None
#     boardPrompt: Optional[str] = None
#     expectedAnswer: Optional[str] = None
#     question: Optional[str] = None
#     choices: List[str] = []
#     selected: List[str] = []
#     messages: List[ChatTurn] = []

# class MCQChatResponse(BaseModel):
#     reply: str

# class AttemptIn(BaseModel):
#     caseId: str
#     subspecialty: str
#     similarity: float
#     rubricHit: int
#     rubricTotal: int
#     letter: str

# class AttemptRow(BaseModel):
#     ts: int = Field(default_factory=lambda: int(time.time()*1000))
#     caseId: str
#     subspecialty: str = "Unknown"
#     similarity: float = 0.0
#     rubricHit: int = 0
#     rubricTotal: int = 0
#     letter: str = ""

# class ProgressOut(BaseModel):
#     reviewedCount: int
#     per: Dict[str, Any]

# class Case(BaseModel):
#     id: str = Field(..., description="Unique case ID, e.g. gi-001")
#     title: str
#     subspecialty: str
#     tags: List[str] = []
#     images: List[str] = []
#     boardPrompt: Optional[str] = None
#     expectedAnswer: Optional[str] = None
#     rubric: List[str] = []

# class UpsertResult(BaseModel):
#     ok: bool
#     id: str
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

class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = ""

class MCQChatRequest(BaseModel):
    mode: Optional[str] = "mcq_chat"
    caseId: Optional[str] = None
    title: Optional[str] = None
    subspecialty: Optional[str] = None
    boardPrompt: Optional[str] = None
    expectedAnswer: Optional[str] = None
    question: Optional[str] = None
    choices: List[str] = []
    selected: List[str] = []
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

# New nested models for Case
class MediaItem(BaseModel):
    type: str  # "image" or "video"
    src: str
    caption: Optional[str] = None
    poster: Optional[str] = None
    autoplay: Optional[bool] = False
    loop: Optional[bool] = False
    muted: Optional[bool] = False

class MCQChoice(BaseModel):
    id: str
    text: str
    correct: Optional[bool] = False
    explain: Optional[str] = None

class MCQQuestion(BaseModel):
    id: str
    stem: str
    choices: List[MCQChoice]
    multi_select: Optional[bool] = False
    shuffle_choices: Optional[bool] = True
    concept_ids: Optional[List[str]] = []

class MCQSpec(BaseModel):
    shuffle_questions: Optional[bool] = False
    questions: List[MCQQuestion] = []

class DifferentialItem(BaseModel):
    label: str

class Differential(BaseModel):
    items: List[DifferentialItem] = []
    min_required: Optional[int] = 1

# Updated Case model with all fields
class Case(BaseModel):
    id: str = Field(..., description="Unique case ID, e.g. gi-001")
    title: str
    subspecialty: str
    tags: List[str] = []
    images: List[str] = []
    media: Optional[List[MediaItem]] = []
    boardPrompt: Optional[str] = None
    expectedAnswer: Optional[str] = None
    rubric: List[str] = []
    references: Optional[List[str]] = []
    mcqs: Optional[MCQSpec] = None
    differential: Optional[Differential] = None
    
    # MongoDB metadata fields (optional) - added to fix 500 error
    created_at: Optional[int] = None
    updated_at: Optional[int] = None
    active: Optional[bool] = None
    created_by: Optional[str] = None
    deleted: Optional[bool] = None
    
    class Config:
        extra = "allow"  # Allow extra fields from MongoDB without failing validation

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

    if not req.messages or (req.messages and req.messages[-1].role != "user"):
        lines.append("What would you like to explore—diagnostic criteria, differentials, or management?")
    return "\n".join(lines)

# -----------------------------
# Routes
# -----------------------------
@app.get("/api/health")
def health():
    return {"ok": True, "mongo": USE_MONGO, "authMode": AUTH_MODE, "model": OPENAI_MODEL}

@app.post("/api/auth/register", response_model=TokenOut)
async def register(body: UserCreate):
    if await get_user(body.email):
        raise HTTPException(400, "User already exists")
    
    log.info(f"=== REGISTER DEBUG ===")
    log.info(f"Email: {body.email}")
    log.info(f"Password length: {len(body.password)}")

    await create_user(body.email, body.password)
    
    user_check = await get_user(body.email)
    log.info(f"User created and verified: {user_check is not None}")
    if user_check:
        log.info(f"Hash starts with: {user_check.get('password_hash', '')[:20]}...")

    token = create_access_token(body.email)
    return TokenOut(access_token=token)

@app.post("/api/auth/login", response_model=TokenOut)
async def login(form: OAuth2PasswordRequestForm = Depends()):
    email = form.username
    user = await get_user(email)

    log.info(f"=== LOGIN DEBUG ===")
    log.info(f"Email: {email}")
    log.info(f"Password length: {len(form.password)}")
    log.info(f"User found: {user is not None}")

    if user:
        log.info(f"Stored hash exists: {bool(user.get('password_hash'))}")
        log.info(f"Hash starts with: {user.get('password_hash', '')[:20]}...")
        
        try:
            password_match = verify_pw(form.password, user["password_hash"])
            log.info(f"Password verification result: {password_match}")
        except Exception as e:
            log.error(f"Password verification error: {e}")
            password_match = False
    else:
        log.info("User not found in database")

    if not user or not verify_pw(form.password, user["password_hash"]):
        log.info("Login failed - returning 401")
        raise HTTPException(401, "Invalid credentials")
    
    token = create_access_token(email)
    log.info("Login successful - returning token")
    return TokenOut(access_token=token)

@app.get("/api/me")
async def me(identity: str = Depends(current_identity)):
    return {"identity": identity, "isAdmin": (not ADMIN_EMAILS) or (identity.lower() in ADMIN_EMAILS)}

# @app.get("/api/cases", response_model=List[Case])
@app.get("/api/cases")
async def list_cases(examMode: bool = False,
                     include_deleted: bool = Query(default=False),
                     identity: str = Depends(current_identity)
                     ):
    if USE_MONGO:
        query = {}
        if not include_deleted:
            query["deleted"] = {"$ne": True}
        cur = db.cases.find(query, {"_id": 0})
        items = await cur.to_list(length=100000)
    else:
        items = _read_cases_file()
        if not include_deleted:
            items = [item for item in items if not item.get("deleted")]
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

@app.get("/api/cases/{case_id}/signed")
async def get_case_with_signed_urls(
    case_id: str,
    identity: str = Depends(current_identity)
):
    """Get a case with signed URLs for all images/videos"""
    
    if not S3_BUCKET:
        raise HTTPException(400, "S3_BUCKET not configured")
    
    # Get the case
    if USE_MONGO:
        doc = await db.cases.find_one({"id": case_id})
        if not doc:
            raise HTTPException(404, "Not found")
        case = dict(doc)
        if '_id' in case:
            del case['_id']
    else:
        cases = _read_cases_file()
        case = next((dict(c) for c in cases if c.get("id") == case_id), None)
        if not case:
            raise HTTPException(404, "Not found")
    
    # Helper function to generate signed URL
    def sign_s3_url(url: str) -> str:
        if not url or S3_BUCKET not in url:
            return url
        try:
            # Extract S3 key from URL
            # https://cm-boards-cases.s3.amazonaws.com/cases/gi-001/image-1.png
            # -> cases/gi-001/image-1.png
            s3_key = url.split(f'{S3_BUCKET}.s3.amazonaws.com/')[-1].split('?')[0]
            signed_url = s3_client.generate_presigned_url(
                'get_object',
                Params={'Bucket': S3_BUCKET, 'Key': s3_key},
                ExpiresIn=3600  # 1 hour
            )
            return signed_url
        except Exception as e:
            log.error(f"Failed to sign URL {url}: {e}")
            return url  # fallback to original
    
    # Sign images
    if case.get('images'):
        case['images'] = [sign_s3_url(img) for img in case['images']]
    
    # Sign videos in media array
    if case.get('media'):
        for media in case['media']:
            if media.get('src'):
                media['src'] = sign_s3_url(media['src'])
            if media.get('poster'):
                media['poster'] = sign_s3_url(media['poster'])
    
    # Sign references
    if case.get('references'):
        for ref in case['references']:
            if ref.get('url'):
                ref['url'] = sign_s3_url(ref['url'])
    
    return case

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
        result = await db.cases.update_one(
            {"id": case_id},
            {"$set": {
                "deleted": True,
                "deletedAt": datetime.now(timezone.utc).isoformat(),
                "deletedBy": identity
            }}
        )
        if result.matched_count == 0: raise HTTPException(404, "Not found")
        return {"ok": True, "message": f"Case {case_id} moved to trash"}
    else:
        items = _read_cases_file()
        found = False
        for item in items:
            if item.get("id") == case_id:
                item["deleted"] = True
                item["deletedAt"] = datetime.now(timezone.utc).isoformat()
                item["deletedBy"] = identity
                found = True
                break
        
        if not found:
            raise HTTPException(404, "Case not found")
        
        _write_cases_file(items)
        return {"ok": True, "message": f"Case {case_id} moved to trash"}
    
@app.post("/api/cases/{case_id}/restore")
async def restore_case(case_id: str, identity: str = Depends(current_identity)):
    """Restore a soft-deleted case"""
    require_admin(identity)
    
    if USE_MONGO:
        result = await db.cases.update_one(
            {"id": case_id},
            {"$unset": {
                "deleted": "",
                "deletedAt": "",
                "deletedBy": ""
            }}
        )
        
        if result.matched_count == 0:
            raise HTTPException(404, "Case not found")
        
        return {"ok": True, "message": f"Case {case_id} restored"}
    else:
        items = _read_cases_file()
        found = False
        for item in items:
            if item.get("id") == case_id:
                item.pop("deleted", None)
                item.pop("deletedAt", None)
                item.pop("deletedBy", None)
                found = True
                break
        
        if not found:
            raise HTTPException(404, "Case not found")
        
        _write_cases_file(items)
        return {"ok": True, "message": f"Case {case_id} restored"}

@app.delete("/api/cases/{case_id}/permanent")
async def permanently_delete_case(case_id: str, identity: str = Depends(current_identity)):
    """PERMANENTLY delete a case (cannot be undone!)"""
    require_admin(identity)
    
    if USE_MONGO:
        result = await db.cases.delete_one({"id": case_id})
        
        if result.deleted_count == 0:
            raise HTTPException(404, "Case not found")
        
        return {"ok": True, "message": f"Case {case_id} permanently deleted"}
    else:
        items = _read_cases_file()
        original_count = len(items)
        items = [x for x in items if x.get("id") != case_id]
        
        if len(items) == original_count:
            raise HTTPException(404, "Case not found")
        
        _write_cases_file(items)
        return {"ok": True, "message": f"Case {case_id} permanently deleted"}

@app.put("/api/cases/{case_id}")
async def update_case(case_id: str, request: Request, identity: str = Depends(current_identity)):
    """Update an existing case"""
    require_admin(identity)
    
    body = await request.json()
    
    if USE_MONGO:
        # Update in MongoDB
        result = await db.cases.update_one(
            {"id": case_id},
            {"$set": {
                "title": body.get("title"),
                "subspecialty": body.get("subspecialty"),
                "boardPrompt": body.get("boardPrompt"),
                "expectedAnswer": body.get("expectedAnswer"),
                "rubric": body.get("rubric", []),
                "tags": body.get("tags", []),
                "images": body.get("images", []),
                "mcqs": body.get("mcqs"),
                "updated_at": int(time.time() * 1000),
                "updated_by": identity
            }}
        )
        
        if result.matched_count == 0:
            raise HTTPException(404, "Case not found")
        
        # Return updated case
        updated_case = await db.cases.find_one({"id": case_id}, {"_id": 0})
        return updated_case
    else:
        items = _read_cases_file()
        found = False
        for item in items:
            if item.get("id") == case_id:
                item.update({
                    "title": body.get("title"),
                    "subspecialty": body.get("subspecialty"),
                    "boardPrompt": body.get("boardPrompt"),
                    "expectedAnswer": body.get("expectedAnswer"),
                    "rubric": body.get("rubric", []),
                    "tags": body.get("tags", []),
                    "images": body.get("images", []),
                    "mcqs": body.get("mcqs"),
                    "updated_at": int(time.time() * 1000),
                    "updated_by": identity
                })
                found = True
                break
        
        if not found:
            raise HTTPException(404, "Case not found")
        
        _write_cases_file(items)
        return item

@app.post("/api/cases/{case_id}/generate-mcqs")
async def generate_mcqs(case_id: str, request: Request, identity: str = Depends(current_identity)):
    """Generate MCQs for a case using LLM"""
    require_admin(identity)
    
    body = await request.json()
    
    # Build prompt for MCQ generation
    prompt = f"""Generate 3-5 high-quality multiple choice questions for this radiology case.

Case Title: {body.get('title', '')}
Subspecialty: {body.get('subspecialty', '')}
Clinical History: {body.get('boardPrompt', '')}
Expected Answer: {body.get('expectedAnswer', '')}

Requirements:
1. Each question should test important diagnostic or management concepts
2. Include 4-5 answer choices per question
3. Mark the correct answer(s) - can have multiple correct answers
4. Provide a brief explanation for the correct answer(s)
5. Make distractors plausible but clearly wrong to an expert
6. Focus on imaging findings, differential diagnosis, or next steps

Return JSON in this exact format:
{{
  "questions": [
    {{
      "stem": "Question text here?",
      "multi_select": false,
      "choices": [
        {{"id": "a", "text": "Choice A text", "correct": false}},
        {{"id": "b", "text": "Choice B text", "correct": true}},
        {{"id": "c", "text": "Choice C text", "correct": false}},
        {{"id": "d", "text": "Choice D text", "correct": false}}
      ],
      "explanation": "Brief explanation of why the answer is correct"
    }}
  ]
}}

Generate the MCQs now:"""

    try:
        if not openai_client:
            raise HTTPException(status_code=500, detail="OpenAI client not configured")
        
        response = openai_client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": "You are an expert radiology educator creating board-style multiple choice questions. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.7,
            max_tokens=2000
        )
        
        content = response.choices[0].message.content.strip()
        
        # Try to parse JSON - handle markdown code blocks if present
        if content.startswith('```'):
            content = content.split('```')[1]
            if content.startswith('json'):
                content = content[4:]
        
        mcqs = json.loads(content)
        
        # Validate structure
        if 'questions' not in mcqs or not isinstance(mcqs['questions'], list):
            raise ValueError("Invalid MCQ format")
        
        return mcqs
        
    except json.JSONDecodeError as e:
        log.error(f"MCQ generation JSON parse error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to parse LLM response: {str(e)}")
    except Exception as e:
        log.error(f"MCQ generation error: {e}")
        raise HTTPException(status_code=500, detail=f"MCQ generation failed: {str(e)}")


@app.post("/api/mcq/chat", response_model=MCQChatResponse)
async def mcq_chat(body: MCQChatRequest, identity: str = Depends(current_identity)):
    system = (
        "You are an expert radiology boards coach. "
        "Use the case context and question to provide concise, high-yield teaching. "
        "Contrast the best answer with top distractors when useful."
    )

    if openai_client and os.getenv("OPENAI_API_KEY"):
        try:
            msgs = [{"role": "system", "content": system}]
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

            for t in body.messages or []:
                msgs.append({"role": t.role, "content": t.content or ""})

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

# =============================
# ADMIN ROUTES
# =============================

def require_admin_user(identity: str = Depends(current_identity)):
    """Check if user is admin"""
    require_admin(identity)
    return identity

@app.post("/api/admin/upload-image")
async def admin_upload_image(
    case_id: str = Form(...),
    file: UploadFile = File(...),
    identity: str = Depends(require_admin_user)
):
    """Upload an image for a case to S3"""
    
    if not S3_BUCKET:
        raise HTTPException(400, "S3_BUCKET not configured")
    
    # Validate case_id format
    if not re.match(r'^[a-z0-9-]+$', case_id):
        raise HTTPException(
            400, 
            f"Invalid case_id '{case_id}'. Must be lowercase letters, numbers, and dashes only (e.g., gi-001, thorax-002)"
        )
    
    if not file.content_type or not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail="File must be an image")
    
    file_ext = file.filename.split('.')[-1].lower()
    timestamp = int(time.time())
    filename = f"image-{timestamp}.{file_ext}"
    s3_key = f"cases/{case_id}/{filename}"
    
    try:
        s3_client.upload_fileobj(
            file.file,
            S3_BUCKET,
            s3_key,
            ExtraArgs={
                'ContentType': file.content_type,
                'CacheControl': 'max-age=31536000'
            }
        )
        
        url = f"https://{S3_BUCKET}.s3.amazonaws.com/{s3_key}"
        return {"status": "success", "url": url, "filename": filename, "s3_key": s3_key}
        
    except Exception as e:
        log.exception("Image upload failed")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@app.post("/api/admin/upload-video")
async def admin_upload_video(
    case_id: str = Form(...),
    file: UploadFile = File(...),
    identity: str = Depends(require_admin_user)
):
    """Upload a video for a case to S3"""
    
    if not S3_BUCKET:
        raise HTTPException(400, "S3_BUCKET not configured")
    
    if not re.match(r'^[a-z0-9-]+$', case_id):
        raise HTTPException(
            400, 
            f"Invalid case_id '{case_id}'. Must be lowercase letters, numbers, and dashes only"
        )
    
    if not file.content_type or not file.content_type.startswith('video/'):
        raise HTTPException(status_code=400, detail="File must be a video")
    
    file_ext = file.filename.split('.')[-1].lower()
    timestamp = int(time.time())
    filename = f"video-{timestamp}.{file_ext}"
    s3_key = f"cases/{case_id}/{filename}"
    
    try:
        s3_client.upload_fileobj(
            file.file,
            S3_BUCKET,
            s3_key,
            ExtraArgs={
                'ContentType': file.content_type,
                'CacheControl': 'max-age=31536000'
            }
        )
        
        url = f"https://{S3_BUCKET}.s3.amazonaws.com/{s3_key}"
        return {"status": "success", "url": url, "filename": filename, "s3_key": s3_key}
        
    except Exception as e:
        log.exception("Video upload failed")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@app.post("/api/admin/upload-reference")
async def admin_upload_reference(
    case_id: str = Form(...),
    file: UploadFile = File(...),
    identity: str = Depends(require_admin_user)
):
    """Upload a reference PDF to S3"""
    
    if not S3_BUCKET:
        raise HTTPException(400, "S3_BUCKET not configured")
    
    if not re.match(r'^[a-z0-9-]+$', case_id):
        raise HTTPException(
            400, 
            f"Invalid case_id '{case_id}'. Must be lowercase letters, numbers, and dashes only"
        )
    
    if file.content_type != 'application/pdf':
        raise HTTPException(status_code=400, detail="File must be a PDF")
    
    safe_filename = file.filename.replace(' ', '-').lower()
    s3_key = f"references/{case_id}/{safe_filename}"
    
    try:
        s3_client.upload_fileobj(
            file.file,
            S3_BUCKET,
            s3_key,
            ExtraArgs={
                'ContentType': 'application/pdf',
                'ContentDisposition': f'inline; filename="{file.filename}"',
                'CacheControl': 'max-age=31536000'
            }
        )
        
        url = f"https://{S3_BUCKET}.s3.amazonaws.com/{s3_key}"
        return {"status": "success", "url": url, "filename": safe_filename, "s3_key": s3_key}
        
    except Exception as e:
        log.exception("Reference upload failed")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@app.post("/api/admin/cases")
async def admin_create_case(
    body: Case,
    identity: str = Depends(require_admin_user)
):
    """Create a new case (admin only)"""
    
    case_dict = body.dict()
    case_dict['created_at'] = int(time.time() * 1000)
    case_dict['updated_at'] = int(time.time() * 1000)
    case_dict['active'] = True
    case_dict['deleted'] = False
    case_dict['created_by'] = identity
    
    if USE_MONGO:
        case_dict['_id'] = body.id
        try:
            await db.cases.insert_one(case_dict)
        except Exception as e:
            log.exception("Failed to insert case")
            raise HTTPException(500, f"Database error: {e}")
    else:
        items = _read_cases_file()
        if any(x.get('id') == body.id for x in items):
            raise HTTPException(400, f"Case {body.id} already exists")
        items.append(case_dict)
        _write_cases_file(items)
    
    return {"status": "success", "case_id": body.id}

@app.get("/api/admin/cases")
async def admin_list_cases(
    include_inactive: bool = False,
    identity: str = Depends(require_admin_user)
):
    """List all cases including metadata (admin only)"""
    
    if USE_MONGO:
        query = {} if include_inactive else {"active": True}
        cursor = db.cases.find(query).sort("created_at", -1)
        cases = await cursor.to_list(length=1000)
        for c in cases:
            if '_id' in c:
                c['id'] = str(c['_id'])
                del c['_id']
        return cases
    else:
        items = _read_cases_file()
        if not include_inactive:
            items = [x for x in items if x.get('active', True)]
        return items

@app.post("/api/cases/{case_id}/generate-rubric")
async def generate_rubric(case_id: str, request: Request, identity: str = Depends(current_identity)):
    """Generate rubric points for a case using LLM"""
    require_admin(identity)
    
    body = await request.json()
    
    prompt = f"""Generate a comprehensive grading rubric for this radiology oral boards case.

Case Title: {body.get('title', '')}
Subspecialty: {body.get('subspecialty', '')}
Clinical History: {body.get('boardPrompt', '')}
Expected Answer: {body.get('expectedAnswer', '')}

Create 5-8 key rubric points that would be used to grade a trainee's oral presentation.

Requirements:
1. Each point should be clear, specific, and measurable
2. Focus on what the trainee should identify, describe, or recommend
3. Cover: study type, key findings, differential diagnosis, diagnosis, and management
4. Be concise (one sentence per point)
5. Use action verbs: "Identifies", "Describes", "States", "Discusses", "Recommends"

Return JSON in this exact format:
{{
  "rubric": [
    "Identifies the study type and technique",
    "Describes the key imaging findings systematically",
    "Provides a differential diagnosis with at least 2-3 possibilities",
    "States the most likely diagnosis with supporting evidence",
    "Discusses appropriate management or next steps"
  ]
}}

Generate the rubric now:"""

    try:
        if not openai_client:
            raise HTTPException(status_code=500, detail="OpenAI client not configured")
        
        response = openai_client.chat.completions.create(
            model=OPENAI_MODEL,
            messages=[
                {"role": "system", "content": "You are an expert radiology educator creating grading rubrics for oral boards. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.5,
            max_tokens=800
        )
        
        content = response.choices[0].message.content.strip()
        
        if content.startswith('```'):
            content = content.split('```')[1]
            if content.startswith('json'):
                content = content[4:]
        
        result = json.loads(content)
        
        if 'rubric' not in result or not isinstance(result['rubric'], list):
            raise ValueError("Invalid rubric format")
        
        return result
        
    except json.JSONDecodeError as e:
        log.error(f"Rubric generation JSON parse error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to parse LLM response: {str(e)}")
    except Exception as e:
        log.error(f"Rubric generation error: {e}")
        raise HTTPException(status_code=500, detail=f"Rubric generation failed: {str(e)}")