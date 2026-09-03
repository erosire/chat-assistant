// Central deployment configuration for the chat-assistant distribution package.
//
// This module is the SINGLE SOURCE OF TRUTH for the host and port of the two
// backend services the UI talks to:
//   1. Database API server  — conversation storage (CRUD) served at /v1/chat-assistant
//      on the DATABASE port.
//   2. Inference provider   — OpenAI-compatible model endpoints at
//      /providers/private/v1 on the (separate) PROVIDER port.
//
// The two services listen on DIFFERENT ports (see the section comments below);
// keeping the raw host+port separate from the assembled URL lets embedders or
// tooling override just the network location without rewriting full URLs, and
// makes the deployment target obvious in one place.
//
// DEPLOYMENT CONTEXT (see ./server-url.ts for the full rationale):
// - This distribution ships as STATIC files (GitHub Pages under a repo path).
// - Origin-relative API paths 404 on the static host, so the assembled URLs in
//   ./server-url.ts and ./provider.ts are built from the absolute origin below.
// - Embedders that need a different backend pass `baseUrl`/`providerUrl` props
//   on `ChatAssistantApp` (components/ChatAssistantApp.tsx:1638-1639) rather
//   than editing these constants.
//
// CROSS-ORIGIN REQUIREMENTS (server side, not fixable from the UI):
// - CORS: the server must allow the hosting origin.
// - Mixed content: an HTTPS-hosted UI (GitHub Pages) cannot fetch() a plain-HTTP
//   origin; either relax mixed-content blocking or terminate HTTPS in front of
//   the backend port.

import {
    LOCAL_AREA_NETWORK_HOST_NAME,
    LOCAL_AREA_NETWORK_DATABASE_PORT,
    LOCAL_AREA_NETWORK_PROVIDER_PORT
} from '@config/environment';

// Host (IPv4 or hostname) of the shared backend. LAN address of the machine
// running the runtime service; kept as a bare string so it can be reused both
// to build the absolute origin and to be displayed/inspected by tooling.
export const DATABASE_API_HOST = LOCAL_AREA_NETWORK_HOST_NAME;

// Port the database API server listens on. The runtime service exposes the
// conversation storage routes (/v1/chat-assistant/...) on this same port.
export const DATABASE_API_PORT = LOCAL_AREA_NETWORK_DATABASE_PORT;

// Inference provider host + port. The provider routes are a SEPARATE service
// from the conversation storage: every runtime endpoint under /providers/private
// declares `port: LOCAL_AREA_NETWORK_PROVIDER_PORT` (see
// runtime/endpoint/provider/private/models/service-route.ts:36,
// .../chat-completion/service-route.ts:7, .../responses/service-route.ts:9,
// .../stats/service-route.ts:22) and the provider clients' Standard URLs agree
// (runtime/secret/private/telnyx.ts:11 pins :5500/providers/private/v1).
// Pinning the UI to the DATABASE port here left the model dropdown fetching
// http://<host>:5000/providers/private/v1/models — nothing listens there, the
// mount effect's catalog GET failed, and the picker degraded to
// "No models available" (the broken-dropdown report).
export const INFERENCE_PROVIDER_HOST = LOCAL_AREA_NETWORK_HOST_NAME;
export const INFERENCE_PROVIDER_PORT = LOCAL_AREA_NETWORK_PROVIDER_PORT;

// Assembled absolute origins. `server-url.ts` re-exports `DEFAULT_SERVER_URL`
// for backwards compatibility with existing imports; that constant is now built
// from the host+port here so the network location has exactly one definition.
// HTTPS is REQUIRED for the LAN origins: the underload service enforces TLS
// for non-loopback peers (packages/underload/service/src/server/start.ts) — a
// plain-http request from this browser UI never reaches the backend. It also
// resolves the mixed-content problem documented in server-url.ts: an
// HTTPS-hosted page (GitHub Pages) can only fetch() HTTPS origins.
export const DATABASE_API_URL = `https://${DATABASE_API_HOST}:${DATABASE_API_PORT}`;
export const INFERENCE_PROVIDER_URL = `https://${INFERENCE_PROVIDER_HOST}:${INFERENCE_PROVIDER_PORT}`;
