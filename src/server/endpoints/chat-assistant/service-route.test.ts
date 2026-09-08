// Route metadata tests confirm service discovery receives the two conversation
// resources and the four agent/tool registry resources.
import { describe, expect, it } from 'vitest';
import agentCollectionRoute from './service-route-agent';
import agentRoute from './service-route-agent-id';
import collectionRoute from './service-route';
import conversationRoute from './service-route-conversation-id';
import toolCollectionRoute from './service-route-tool';
import toolRoute from './service-route-tool-id';

describe('chat assistant service routes', () => {
    it('registers the collection route for conversation listing and creation', () => {
        expect(collectionRoute.route).toBe('/v1/chat-assistant/conversation');
        expect(typeof collectionRoute.handler).toBe('function');
    });

    it('registers the identified route for GET, POST, PUT, and DELETE operations', () => {
        expect(conversationRoute.route).toBe('/v1/chat-assistant/conversation/:conversation_id');
        expect(typeof conversationRoute.handler).toBe('function');
    });

    it('registers the agent collection and identified routes', () => {
        expect(agentCollectionRoute.route).toBe('/v1/chat-assistant/agent');
        expect(typeof agentCollectionRoute.handler).toBe('function');
        expect(agentRoute.route).toBe('/v1/chat-assistant/agent/:agent_id');
        expect(typeof agentRoute.handler).toBe('function');
    });

    it('registers the tool collection and identified routes', () => {
        expect(toolCollectionRoute.route).toBe('/v1/chat-assistant/tool');
        expect(typeof toolCollectionRoute.handler).toBe('function');
        expect(toolRoute.route).toBe('/v1/chat-assistant/tool/:tool_id');
        expect(typeof toolRoute.handler).toBe('function');
    });
});
