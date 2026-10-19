import { useCallback, useEffect, useRef, useState } from "react";

type Msg = { id: number; user: string; content: string; created_at: string; client_id?: string | null; pending?: boolean };
type Pt = [number, number];
type Stroke = { stroke_id: string; user?: string; color: string; width: number; points: Pt[] };
type Room = { id: number; name: string; online: number };
type Frame = { type: string; payload: any }; // eslint-disable-line
type Session = { token: string; username: string };

async function api<T>(path: string, token?: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail?.toString() ?? "Erreur");
  return d as T;
}

const EPHEMERAL = new Set(["board.cursor", "chat.typing", "ping"]);
function useSocket(roomId: number, token: string, onFrame: (f: Frame) => void) {
  const [status, setStatus] = useState<"connexion" | "ouvert" | "reconnexion">("connexion");
  const ws = useRef<WebSocket | null>(null);
  const queue = useRef<string[]>([]);
  const handler = useRef(onFrame);
  handler.current = onFrame;
  useEffect(() => {
    let closed = false, tries = 0, timer: number, beat: number;
    const open = () => {
      const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/rooms/${roomId}?token=${token}`);
      ws.current = s;
      s.onopen = () => { tries = 0; setStatus("ouvert"); queue.current.splice(0).forEach((m) => s.send(m)); beat = window.setInterval(() => s.send('{"type":"ping","payload":{}}'), 20000); };
      s.onmessage = (e) => handler.current(JSON.parse(e.data));
      s.onclose = (e) => {
        clearInterval(beat);
        if (closed || e.code === 4001 || e.code === 4003) return;
        setStatus("reconnexion");
        timer = window.setTimeout(open, Math.min(30000, 500 * 2 ** tries++) * (0.5 + Math.random() / 2)); // backoff exponentiel + jitter
      };
    };
    open();
    return () => { closed = true; clearTimeout(timer); clearInterval(beat); ws.current?.close(); };
  }, [roomId, token]);
  const send = useCallback((type: string, payload: object) => {
    const m = JSON.stringify({ type, payload });
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(m);
    else if (!EPHEMERAL.has(type)) queue.current.push(m); // file d'attente pendant la coupure
  }, []);
  return { status, send };
}

function Auth({ onAuth }: { onAuth: (s: Session) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [u, setU] = useState(""), [p, setP] = useState(""), [err, setErr] = useState("");
  const go = async () => {
    try { onAuth(await api<Session>(`/api/auth/${mode}`, undefined, { username: u, password: p })); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="card">
      <h1>Atelier</h1>
      <p className="mute">Discutez et dessinez ensemble, en direct.</p>
      <input aria-label="Nom d'utilisateur" placeholder="Nom d'utilisateur" value={u} onChange={(e) => setU(e.target.value)} />
      <input aria-label="Mot de passe" type="password" placeholder="Mot de passe (6 caractères min.)" value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      {err && <div role="alert">{err}</div>}
      <button onClick={go}>{mode === "login" ? "Se connecter" : "Créer mon compte"}</button>
      <button className="ghost" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "Pas de compte ? Inscription" : "Déjà inscrit ? Connexion"}</button>
    </div>
  );
}

const colorOf = (n: string) => `hsl(${[...n].reduce((a, c) => a + c.charCodeAt(0) * 37, 0) % 360} 65% 42%)`;

function drawStroke(c: CanvasRenderingContext2D, s: Stroke, W: number, H: number) {
  const p = s.points;
  if (!p.length) return;
  c.strokeStyle = s.color; c.lineWidth = s.width; c.lineCap = c.lineJoin = "round";
  c.beginPath(); c.moveTo(p[0][0] * W, p[0][1] * H);
  for (let i = 1; i < p.length - 1; i++) c.quadraticCurveTo(p[i][0] * W, p[i][1] * H, ((p[i][0] + p[i + 1][0]) / 2) * W, ((p[i][1] + p[i + 1][1]) / 2) * H); // lissage Bézier
  const l = p[p.length - 1]; c.lineTo(l[0] * W, l[1] * H); c.stroke();
}

function RoomView({ room, s }: { room: Room; s: Session }) {
  const [tab, setTab] = useState<"chat" | "board">("chat");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [online, setOnline] = useState<string[]>([]);
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [text, setText] = useState("");
  const [cursors, setCursors] = useState<Record<string, { x: number; y: number; t: number }>>({});
  const strokes = useRef(new Map<string, Stroke>());
  const [rev, setRev] = useState(0);
  const [color, setColor] = useState("#1f5eff"), [width, setWidth] = useState(4), [eraser, setEraser] = useState(false);
  const cv = useRef<HTMLCanvasElement>(null);
  const last = useRef(0), lastTyping = useRef(0), mine = useRef<Stroke | null>(null), buf = useRef<Pt[]>([]), flushAt = useRef(0);

  const merge = (list: Msg[]) => setMsgs((cur) => {
    const m = new Map<string, Msg>();
    [...cur, ...list].forEach((x) => m.set(x.client_id && cur.some((c) => c.client_id === x.client_id) ? x.client_id : `id${x.id}`, { ...x, pending: false }));
    return [...m.values()].sort((a, b) => (a.pending ? 1e12 : a.id) - (b.pending ? 1e12 : b.id));
  });
  const { status, send } = useSocket(room.id, s.token, (f) => {
    const p = f.payload;
    if (f.type === "chat.message") merge([p]);
    else if (f.type === "presence.update") setOnline(p.online);
    else if (f.type === "chat.typing") setTyping((t) => ({ ...t, [p.user]: p.is_typing ? Date.now() : 0 }));
    else if (f.type === "board.cursor") setCursors((c) => ({ ...c, [p.user]: { x: p.x, y: p.y, t: Date.now() } }));
    else if (f.type === "board.snapshot") { strokes.current = new Map((p as Stroke[]).map((x) => [x.stroke_id, x])); setRev((r) => r + 1); }
    else if (f.type === "board.stroke.start") { strokes.current.set(p.stroke_id, { stroke_id: p.stroke_id, user: p.user, color: p.color, width: p.width, points: [p.point] }); setRev((r) => r + 1); }
    else if (f.type === "board.stroke.points") { strokes.current.get(p.stroke_id)?.points.push(...p.points); setRev((r) => r + 1); }
    else if (f.type === "board.stroke.delete") { strokes.current.delete(p.stroke_id); setRev((r) => r + 1); }
    else if (f.type === "board.clear") { strokes.current.clear(); setRev((r) => r + 1); }
  });

  // historique + resynchronisation à chaque (re)connexion
  useEffect(() => { if (status === "ouvert") api<Msg[]>(`/api/rooms/${room.id}/messages?limit=50`, s.token).then(merge); }, [status]); // eslint-disable-line
  useEffect(() => { const i = setInterval(() => { const n = Date.now(); setTyping((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => n - v < 3000))); setCursors((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => n - v.t < 5000))); }, 1000); return () => clearInterval(i); }, []);

  const older = async () => { const f = msgs.find((m) => !m.pending); if (f) merge(await api<Msg[]>(`/api/rooms/${room.id}/messages?limit=50&before_id=${f.id}`, s.token)); };
  const post = () => {
    const t = text.trim(); if (!t) return;
    const cid = crypto.randomUUID();
    setMsgs((m) => [...m, { id: 0, user: s.username, content: t, created_at: new Date().toISOString(), client_id: cid, pending: true }]); // affichage optimiste
    send("chat.message", { content: t, client_id: cid }); send("chat.typing", { is_typing: false }); setText("");
  };

  useEffect(() => {
    const c = cv.current; if (!c || tab !== "board") return;
    c.width = c.clientWidth; c.height = c.clientHeight;
    const g = c.getContext("2d")!; g.clearRect(0, 0, c.width, c.height);
    strokes.current.forEach((x) => drawStroke(g, x, c.width, c.height));
  }, [rev, tab]);
  const norm = (e: React.PointerEvent): Pt => { const r = cv.current!.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const flush = () => { if (mine.current && buf.current.length) { send("board.stroke.points", { stroke_id: mine.current.stroke_id, points: buf.current }); buf.current = []; } };
  const down = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const pt = norm(e), st = { stroke_id: crypto.randomUUID(), color: eraser ? "#ffffff" : color, width: eraser ? width * 4 : width, points: [pt] };
    mine.current = st; strokes.current.set(st.stroke_id, st); send("board.stroke.start", { stroke_id: st.stroke_id, color: st.color, width: st.width, point: pt }); setRev((r) => r + 1);
  };
  const move = (e: React.PointerEvent) => {
    const pt = norm(e), n = Date.now();
    if (n - last.current > 30) { last.current = n; send("board.cursor", { x: pt[0], y: pt[1] }); }
    if (!mine.current) return;
    mine.current.points.push(pt); buf.current.push(pt); setRev((r) => r + 1);
    if (n - flushAt.current > 40) { flushAt.current = n; flush(); } // batching des points
  };
  const up = () => { if (!mine.current) return; flush(); send("board.stroke.end", { stroke_id: mine.current.stroke_id }); mine.current = null; };
  const png = () => { const a = document.createElement("a"); a.href = cv.current!.toDataURL("image/png"); a.download = `${room.name}.png`; a.click(); };
  const writers = Object.entries(typing).filter(([u, v]) => v && u !== s.username).map(([u]) => u);

  return (
    <main>
      <div className="bar">
        <strong>{room.name}</strong>
        <button className={tab === "chat" ? "" : "ghost"} onClick={() => setTab("chat")}>Discussion</button>
        <button className={tab === "board" ? "" : "ghost"} onClick={() => setTab("board")}>Tableau blanc</button>
        <span className="status">{status === "ouvert" ? `En ligne : ${online.join(", ")}` : `Connexion perdue, ${status}…`}</span>
      </div>
      {tab === "chat" ? (<>
        <div className="msgs">
          <button className="ghost" onClick={older}>Charger les messages précédents</button>
          {msgs.length === 0 && <p className="mute">Aucun message. Écrivez le premier.</p>}
          {msgs.map((m) => <p className="msg" key={m.client_id ?? m.id} style={{ opacity: m.pending ? 0.5 : 1 }}><b style={{ color: colorOf(m.user) }}>{m.user}</b>{m.content} <small>{new Date(m.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</small></p>)}
        </div>
        <div className="status" style={{ padding: "0 16px", minHeight: 20 }}>{writers.length ? `${writers.join(", ")} ${writers.length > 1 ? "écrivent" : "écrit"}…` : ""}</div>
        <div className="compose">
          <input aria-label="Message" placeholder="Votre message" value={text} onChange={(e) => { setText(e.target.value); if (Date.now() - lastTyping.current > 2000) { lastTyping.current = Date.now(); send("chat.typing", { is_typing: true }); } }} onKeyDown={(e) => e.key === "Enter" && post()} />
          <button onClick={post}>Envoyer</button>
        </div>
      </>) : (<>
        <div className="bar">
          <input type="color" aria-label="Couleur" value={color} onChange={(e) => { setColor(e.target.value); setEraser(false); }} />
          <input type="range" aria-label="Épaisseur" min={1} max={24} value={width} onChange={(e) => setWidth(+e.target.value)} />
          <button className={eraser ? "" : "ghost"} onClick={() => setEraser(!eraser)}>Gomme</button>
          <button className="ghost" onClick={() => send("board.undo", {})}>Annuler mon dernier trait</button>
          <button className="ghost" onClick={() => confirm("Effacer tout le tableau pour tout le monde ?") && send("board.clear", {})}>Tout effacer</button>
          <button className="ghost" onClick={png}>Exporter en PNG</button>
        </div>
        <div className="boardwrap">
          <canvas ref={cv} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
          {Object.entries(cursors).map(([u, c]) => <div key={u} className="cur" style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, background: colorOf(u), transition: "left 60ms linear, top 60ms linear" }}>{u}</div>)}
        </div>
      </>)}
    </main>
  );
}

export default function App() {
  const [s, setS] = useState<Session | null>(() => JSON.parse(sessionStorage.getItem("s") ?? "null"));
  const [rooms, setRooms] = useState<Room[]>([]);
  const [cur, setCur] = useState<Room | null>(null);
  const [name, setName] = useState(""), [err, setErr] = useState("");
  const load = useCallback(() => s && api<Room[]>("/api/rooms", s.token).then(setRooms).catch(() => { sessionStorage.removeItem("s"); setS(null); }), [s]);
  useEffect(() => { load(); }, [load]);
  if (!s) return <Auth onAuth={(x) => { sessionStorage.setItem("s", JSON.stringify(x)); setS(x); }} />;
  const create = async () => { try { const r = await api<Room>("/api/rooms", s.token, { name }); setName(""); setErr(""); await load(); setCur(r); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="shell">
      <aside>
        <h2>Salons</h2>
        {rooms.map((r) => <button key={r.id} className={`room ${cur?.id === r.id ? "" : "ghost"}`} onClick={() => { setCur(r); load(); }}>{r.name} <small>({r.online} en ligne)</small></button>)}
        <p><input aria-label="Nouveau salon" placeholder="Nom du salon" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} /></p>
        <button onClick={create}>Créer le salon</button>
        {err && <div role="alert">{err}</div>}
        <p className="mute">Connecté : {s.username} <button className="ghost" onClick={() => { sessionStorage.removeItem("s"); setS(null); setCur(null); }}>Quitter</button></p>
      </aside>
      {cur ? <RoomView key={cur.id} room={cur} s={s} /> : <main><p className="mute" style={{ padding: 24 }}>Choisissez un salon ou créez-en un.</p></main>}
    </div>
  );
}
