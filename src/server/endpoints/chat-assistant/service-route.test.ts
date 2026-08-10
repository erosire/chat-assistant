// Route metadata tests confirm service discovery receives the two conversation resources.
import { describe, expect, it } from 'vitest';
import collectionRoute from './service-route';
import conversationRoute from './service-route-conversation-id';

describe('chat assistant service routes', () => {
    it('registers the collection route for conversation listing and creation', () => {
        expect(collectionRoute.route).toBe('/v1/chat-assistant/conversation');
        expect(typeof collectionRoute.handler).toBe('function');
    });

    it('registers the identified route for GET, POST, PUT, and DELETE operations', () => {
        expect(conversationRoute.route).toBe('/v1/chat-assistant/conversation/:conversation_id');
        expect(typeof conversationRoute.handler).toBe('function');
    });
});
