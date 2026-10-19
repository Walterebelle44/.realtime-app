# Atelier : chat en salons + tableau blanc collaboratif

FastAPI (WebSocket) + React/TypeScript + PostgreSQL.

## Lancer
    docker compose up --build        # http://localhost:8080

## Développement
    cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload   # SQLite par défaut
    cd frontend && npm install && npm run dev                                         # http://localhost:5173

## Fonctionnalités
Auth JWT, salons, chat temps réel (affichage optimiste, historique paginé, « écrit… », présence multi-onglets),
tableau blanc (traits lissés, curseurs distants, undo, effacement, export PNG, snapshot à l'arrivée),
heartbeat, reconnexion avec backoff + jitter, file d'attente et resynchronisation, rate limiting, limites de taille.

## Protocole
Trames `{"type","payload"}` : chat.message, chat.typing, presence.update, board.cursor, board.stroke.start|points|end|delete, board.undo, board.clear, board.snapshot, ping/pong.
Codes de fermeture : 4001 non authentifié, 4003 interdit, 4008 débit, 4009 trame invalide.

## Variables
`JWT_SECRET`, `DATABASE_URL`, `ALLOWED_ORIGINS`.
