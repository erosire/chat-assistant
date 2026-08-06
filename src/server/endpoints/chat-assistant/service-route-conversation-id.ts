// Service discovery loads this identified conversation resource alongside the
// collection route in service-route.ts.
import { asServiceHandler } from '@underload/service';
import { conversationDelete, conversationGet, conversationPost } from './chat-assistant';

// GET reads, POST appends to, and DELETE permanently removes one conversation.
export default {
    route: '/v1/chat-assistant/conversation/:conversation_id',
    handler: asServiceHandler({
        GET: conversationGet,
        POST: conversationPost,
        DELETE: conversationDelete
    })
};
