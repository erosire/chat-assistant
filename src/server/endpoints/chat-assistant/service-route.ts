// Service discovery loads every service-route*.ts module below an endpoints folder.
import { asServiceHandler } from '@underload/service';
import { conversationCreate, conversationList } from './chat-assistant';

// The collection exposes GET for the persisted conversation list (compact summaries
// only, so a reloaded UI restores its chat history) and POST for creation; message
// bodies remain on the identified resource in service-route-conversation-id.ts.
export default {
    route: '/v1/chat-assistant/conversation',
    handler: asServiceHandler({
        GET: conversationList,
        POST: conversationCreate
    })
};
