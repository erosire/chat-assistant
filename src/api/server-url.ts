// Single source of truth for the chat-assistant backend server origin.
//
// DEPLOYMENT CONTEXT: this distribution is deployed as STATIC files (GitHub
// Pages under a repository path, e.g. https://<user>.github.io/chat-assistant/).
// Origin-relative API paths ('/v1/chat-assistant/...', '/providers/private/v1')
// resolve against the STATIC HOST'S ORIGIN at runtime — github.io serves no API
// routes, so every request answered 404 there. The defaults in ./chat-assistant
// (DEFAULT_CHAT_ASSISTANT_URL) and ./provider (DEFAULT_PROVIDER_URL) are built
// from this absolute origin so the UI reaches the real backend NO MATTER WHERE
// THE STATIC FILES ARE HOSTED (GitHub Pages, LAN file server, vite dev, etc.).
//
// The matching OpenAPI spec server entry is
// src/server/endpoints/chat-assistant.yml (`servers[0].url`), and the vite dev
// proxy that used to forward relative paths (removed from vite.config.ts) is no
// longer consulted because the app never issues relative-path requests.
//
// CROSS-ORIGIN REQUIREMENTS (server side, not fixable from the UI):
// - CORS: the server must allow the hosting origin (runtime/endpoint/proxy's
//   CORS handler already emits Access-Control-Allow-Origin when this service
//   is fronted by that proxy).
// - Mixed content: browsers block fetch() calls from an HTTPS page (GitHub
//   Pages) to a plain-HTTP origin. Viewing the deployed UI therefore requires
//   a browser/profile with mixed-content blocking relaxed, or an HTTPS-
//   terminated reverse proxy in front of port 5000.
// Embedders that need a different backend pass the baseUrl/providerUrl props on
// ChatAssistantApp (components/ChatAssistantApp.tsx:1577-1580) instead of
// editing this constant.
export const DEFAULT_SERVER_URL = 'http://192.168.8.128:5000';
