// Regression tests for the central deployment config. The host/port below are
// the single source of truth that server-url.ts and provider.ts assemble the
// default API URLs from; if they regress, the assembled URLs break too.
// CRITICAL: the inference provider listens on ITS OWN port
// (LOCAL_AREA_NETWORK_PROVIDER_PORT) — pinning INFERENCE_PROVIDER_PORT to the
// database port pointed the model dropdown's catalog GET at a port nothing
// listens on (the broken-dropdown regression this suite guards).
import { describe, expect, it } from 'vitest';
import {
    LOCAL_AREA_NETWORK_HOST_NAME,
    LOCAL_AREA_NETWORK_DATABASE_PORT,
    LOCAL_AREA_NETWORK_PROVIDER_PORT
} from '@config/environment';
import {
    DATABASE_API_HOST,
    DATABASE_API_PORT,
    DATABASE_API_URL,
    INFERENCE_PROVIDER_HOST,
    INFERENCE_PROVIDER_PORT,
    INFERENCE_PROVIDER_URL
} from './config';
import { DEFAULT_SERVER_URL } from './server-url';

describe('deployment config host/port', () => {
    it('exposes the database API server host and port', () => {
        expect(DATABASE_API_HOST).toBe(LOCAL_AREA_NETWORK_HOST_NAME);
        expect(DATABASE_API_PORT).toBe(LOCAL_AREA_NETWORK_DATABASE_PORT);
    });

    it('exposes the inference provider host and port', () => {
        expect(INFERENCE_PROVIDER_HOST).toBe(LOCAL_AREA_NETWORK_HOST_NAME);
        // The provider service is distinct from the database service: its port
        // must track LOCAL_AREA_NETWORK_PROVIDER_PORT (what every runtime
        // /providers/private route actually binds), never the database port.
        expect(INFERENCE_PROVIDER_PORT).toBe(LOCAL_AREA_NETWORK_PROVIDER_PORT);
    });

    it('assembles the database API absolute origin from host+port', () => {
        expect(DATABASE_API_URL).toBe(`http://${LOCAL_AREA_NETWORK_HOST_NAME}:${LOCAL_AREA_NETWORK_DATABASE_PORT}`);
    });

    it('assembles the inference provider absolute origin from host+port', () => {
        expect(INFERENCE_PROVIDER_URL).toBe(`http://${LOCAL_AREA_NETWORK_HOST_NAME}:${LOCAL_AREA_NETWORK_PROVIDER_PORT}`);
    });

    it('keeps DEFAULT_SERVER_URL in sync with the database API origin', () => {
        // server-url.ts derives DEFAULT_SERVER_URL from DATABASE_API_URL; this
        // asserts the derivation wiring stays intact if either side changes.
        expect(DEFAULT_SERVER_URL).toBe(DATABASE_API_URL);
    });
});
