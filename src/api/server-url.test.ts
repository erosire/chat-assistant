// Deployment-fix regression tests: the UI default endpoints must be ABSOLUTE
// URLs pinned to the LAN backend. If these ever regress to origin-relative
// paths, a GitHub Pages build resolves them against github.io (no API routes)
// and every request 404s — the bug this module fixed (see ./server-url.ts).
import { describe, expect, it } from 'vitest';
import { LOCAL_AREA_NETWORK_HOST_NAME, LOCAL_AREA_NETWORK_DATABASE_PORT } from '@config/environment';
import { DEFAULT_SERVER_URL } from './server-url';
import { DEFAULT_CHAT_ASSISTANT_URL } from './chat-assistant';
import { DEFAULT_PROVIDER_URL } from './provider';

describe('deployment-independent default API URLs', () => {
    it('pins the backend origin to the LAN server on port 5000', () => {
        expect(DEFAULT_SERVER_URL).toBe(`http://${LOCAL_AREA_NETWORK_HOST_NAME}:${LOCAL_AREA_NETWORK_DATABASE_PORT}`);
    });

    it('pins the conversation storage default to the absolute LAN endpoint', () => {
        expect(DEFAULT_CHAT_ASSISTANT_URL).toBe(`http://${LOCAL_AREA_NETWORK_HOST_NAME}:${LOCAL_AREA_NETWORK_DATABASE_PORT}/v1/chat-assistant/conversation`);
    });

    it('pins the runtime provider default to the absolute LAN endpoint', () => {
        expect(DEFAULT_PROVIDER_URL).toBe(`http://${LOCAL_AREA_NETWORK_HOST_NAME}:${LOCAL_AREA_NETWORK_DATABASE_PORT}/providers/private/v1`);
    });
});
