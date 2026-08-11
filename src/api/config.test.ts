// Regression tests for the central deployment config. The host/port below are
// the single source of truth that server-url.ts and provider.ts assemble the
// default API URLs from; if they regress, the assembled URLs break too.
import { describe, expect, it } from 'vitest';
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
        expect(DATABASE_API_HOST).toBe('192.168.8.128');
        expect(DATABASE_API_PORT).toBe(5000);
    });

    it('exposes the inference provider host and port', () => {
        expect(INFERENCE_PROVIDER_HOST).toBe('192.168.8.128');
        expect(INFERENCE_PROVIDER_PORT).toBe(5000);
    });

    it('assembles the database API absolute origin from host+port', () => {
        expect(DATABASE_API_URL).toBe('http://192.168.8.128:5000');
    });

    it('assembles the inference provider absolute origin from host+port', () => {
        expect(INFERENCE_PROVIDER_URL).toBe('http://192.168.8.128:5000');
    });

    it('keeps DEFAULT_SERVER_URL in sync with the database API origin', () => {
        // server-url.ts derives DEFAULT_SERVER_URL from DATABASE_API_URL; this
        // asserts the derivation wiring stays intact if either side changes.
        expect(DEFAULT_SERVER_URL).toBe(DATABASE_API_URL);
    });
});
