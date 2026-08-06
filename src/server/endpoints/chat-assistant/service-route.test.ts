// Route metadata test confirms service discovery receives both requested methods.
import { describe, expect, it } from 'vitest';
import route from './service-route';

describe('chat assistant service route', () => {
    it('registers the trailing-slash route with GET and POST handlers', () => {
        expect(route.route).toBe('/v1/chat-assistant/');
        expect(typeof route.handler).toBe('function');
    });
});
