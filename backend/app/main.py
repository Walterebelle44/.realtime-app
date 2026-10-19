import os, json, time, hashlib, hmac, secrets
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import jwt
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import String, Text, Integer, JSON, DateTime, Boolean, select, update
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

DB = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./app.db")
SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")
engine = create_async_engine(DB)
Session = async_sessionmaker(engine, expire_on_commit=False)
now = lambda: datetime.now(timezone.utc)

class Base(DeclarativeBase): pass
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(32), unique=True)
    password_hash: Mapped[str] = mapped_column(String(200))
class Room(Base):
    __tablename__ = "rooms"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True)
class Message(Base):
    __tablename__ = "messages"
    id: Mapped[int] = mapped_column(primary_key=True)
    room_id: Mapped[int] = mapped_column(Integer, index=True)
    username: Mapped[str] = mapped_column(String(32))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
class Stroke(Base):
    __tablename__ = "board_strokes"
    id: Mapped[int] = mapped_column(primary_key=True)
    room_id: Mapped[int] = mapped_column(Integer, index=True)
    username: Mapped[str] = mapped_column(String(32))
    stroke_id: Mapped[str] = mapped_column(String(40))
    color: Mapped[str] = mapped_column(String(9))
    width: Mapped[int] = mapped_column(Integer)
    points: Mapped[list] = mapped_column(JSON)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)

@asynccontextmanager
async def lifespan(app):
    async with engine.begin() as c: await c.run_sync(Base.metadata.create_all)
    yield
app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["*"], allow_headers=["*"])

def hash_pw(p, salt=None):
    salt = salt or secrets.token_hex(8)
    return salt + "$" + hashlib.pbkdf2_hmac("sha256", p.encode(), salt.encode(), 120_000).hex()
def check_pw(p, h): return hmac.compare_digest(hash_pw(p, h.split("$")[0]), h)
def make_token(u): return jwt.encode({"sub": u, "exp": now() + timedelta(hours=12)}, SECRET, "HS256")
def read_token(t):
    try: return jwt.decode(t, SECRET, ["HS256"])["sub"]
    except jwt.PyJWTError: return None
async def current_user(authorization: str = Header(default="")):
    u = read_token(authorization.removeprefix("Bearer "))
    if not u: raise HTTPException(401, "Non authentifié")
    return u

class Creds(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=r"^[\w.-]+$")
    password: str = Field(min_length=6, max_length=128)
class RoomIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)

@app.get("/health")
async def health(): return {"ok": True}

@app.post("/api/auth/register")
async def register(c: Creds):
    async with Session() as s:
        if (await s.execute(select(User).where(User.username == c.username))).scalar():
            raise HTTPException(409, "Nom déjà pris")
        s.add(User(username=c.username, password_hash=hash_pw(c.password))); await s.commit()
    return {"token": make_token(c.username), "username": c.username}

@app.post("/api/auth/login")
async def login(c: Creds):
    async with Session() as s:
        u = (await s.execute(select(User).where(User.username == c.username))).scalar()
    if not u or not check_pw(c.password, u.password_hash): raise HTTPException(401, "Identifiants invalides")
    return {"token": make_token(c.username), "username": c.username}

@app.get("/api/rooms")
async def rooms(_: str = Depends(current_user)):
    async with Session() as s:
        rs = (await s.execute(select(Room).order_by(Room.id))).scalars().all()
    return [{"id": r.id, "name": r.name, "online": len(set(mgr.rooms[r.id].values()))} for r in rs]

@app.post("/api/rooms")
async def create_room(r: RoomIn, _: str = Depends(current_user)):
    async with Session() as s:
        if (await s.execute(select(Room).where(Room.name == r.name))).scalar(): raise HTTPException(409, "Salon existant")
        room = Room(name=r.name); s.add(room); await s.commit()
    return {"id": room.id, "name": room.name, "online": 0}

@app.get("/api/rooms/{rid}/messages")
async def history(rid: int, before_id: int | None = None, limit: int = 50, _: str = Depends(current_user)):
    q = select(Message).where(Message.room_id == rid)
    if before_id: q = q.where(Message.id < before_id)
    async with Session() as s:
        ms = (await s.execute(q.order_by(Message.id.desc()).limit(min(limit, 100)))).scalars().all()
    return [msg_json(m) for m in reversed(ms)]

def msg_json(m, client_id=None):
    return {"id": m.id, "user": m.username, "content": m.content, "created_at": m.created_at.isoformat(), "client_id": client_id}

class Manager:
    def __init__(self): self.rooms: dict[int, dict[WebSocket, str]] = defaultdict(dict)
    def online(self, rid): return sorted(set(self.rooms[rid].values()))  # multi-onglets : en ligne tant qu'une connexion reste
    async def send(self, ws, type_, payload):
        try: await ws.send_text(json.dumps({"type": type_, "payload": payload}))
        except Exception: pass
    async def broadcast(self, rid, type_, payload, skip=None):
        for ws in list(self.rooms[rid]):
            if ws is not skip: await self.send(ws, type_, payload)
mgr = Manager()
MAX_FRAME, MAX_POINTS, RATE = 64_000, 5000, 120  # trames/s max

@app.websocket("/ws/rooms/{rid}")
async def ws_room(ws: WebSocket, rid: int, token: str = ""):
    user = read_token(token)
    origin = ws.headers.get("origin")
    if ORIGINS != ["*"] and origin and origin not in ORIGINS: return await ws.close(4003)
    if not user: return await ws.close(4001)
    async with Session() as s:
        if not await s.get(Room, rid): return await ws.close(4003)
        strokes = (await s.execute(select(Stroke).where(Stroke.room_id == rid, Stroke.deleted == False).order_by(Stroke.id))).scalars().all()
    await ws.accept()
    mgr.rooms[rid][ws] = user
    await mgr.send(ws, "board.snapshot", [{"stroke_id": x.stroke_id, "user": x.username, "color": x.color, "width": x.width, "points": x.points} for x in strokes])
    await mgr.broadcast(rid, "presence.update", {"online": mgr.online(rid)})
    live: dict[str, dict] = {}
    window, count = time.monotonic(), 0
    try:
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_FRAME: await ws.close(4009); break
            t = time.monotonic()
            if t - window > 1: window, count = t, 0
            count += 1
            if count > RATE: await ws.close(4008); break
            try: f = json.loads(raw); typ, p = f["type"], f["payload"]
            except (ValueError, KeyError, TypeError): await ws.close(4009); break
            if typ == "ping": await mgr.send(ws, "pong", {})
            elif typ == "chat.message":
                text = str(p.get("content", "")).strip()[:2000]
                if not text: continue
                async with Session() as s:
                    m = Message(room_id=rid, username=user, content=text); s.add(m); await s.commit()
                await mgr.broadcast(rid, "chat.message", msg_json(m, p.get("client_id")))
            elif typ == "chat.typing": await mgr.broadcast(rid, "chat.typing", {"user": user, "is_typing": bool(p.get("is_typing"))}, skip=ws)
            elif typ == "board.cursor": await mgr.broadcast(rid, "board.cursor", {"user": user, "x": p["x"], "y": p["y"]}, skip=ws)
            elif typ == "board.stroke.start":
                live[p["stroke_id"]] = {"color": str(p["color"])[:9], "width": min(int(p["width"]), 60), "points": [p["point"]]}
                await mgr.broadcast(rid, typ, {**p, "user": user}, skip=ws)
            elif typ == "board.stroke.points" and p["stroke_id"] in live:
                pts = live[p["stroke_id"]]["points"]
                if len(pts) + len(p["points"]) <= MAX_POINTS: pts.extend(p["points"])
                await mgr.broadcast(rid, typ, p, skip=ws)
            elif typ == "board.stroke.end" and p["stroke_id"] in live:
                d = live.pop(p["stroke_id"])
                async with Session() as s:
                    s.add(Stroke(room_id=rid, username=user, stroke_id=p["stroke_id"], **d)); await s.commit()
                await mgr.broadcast(rid, typ, p, skip=ws)
            elif typ == "board.undo":
                async with Session() as s:
                    last = (await s.execute(select(Stroke).where(Stroke.room_id == rid, Stroke.username == user, Stroke.deleted == False).order_by(Stroke.id.desc()).limit(1))).scalar()
                    if last: last.deleted = True; await s.commit()
                if last: await mgr.broadcast(rid, "board.stroke.delete", {"stroke_id": last.stroke_id})
            elif typ == "board.clear":
                async with Session() as s:
                    await s.execute(update(Stroke).where(Stroke.room_id == rid).values(deleted=True)); await s.commit()
                await mgr.broadcast(rid, "board.clear", {})
    except WebSocketDisconnect: pass
    finally:
        mgr.rooms[rid].pop(ws, None)
        await mgr.broadcast(rid, "presence.update", {"online": mgr.online(rid)})
