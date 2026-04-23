// Socket.io server URL. VITE_WS_URL is injected at build time in
// production; the localhost fallback keeps `npm run dev` working out of
// the box. Shared by main.js (game socket) and SplashScreen (short-lived
// career/leaderboard query socket).
export const WS_URL = import.meta.env?.VITE_WS_URL || 'http://localhost:2567';
