// Service discovery loads every service-route*.ts module below an endpoints folder.
import { asServiceHandler } from '@underload/service';
import { chatAssistantGet, chatAssistantPost } from './chat-assistant';

// GET lists or reads chats; POST creates a chat or appends a user message.
export default {
    route: '/v1/chat-assistant/',
    handler: asServiceHandler({
        GET: chatAssistantGet,
        POST: chatAssistantPost
    })
};
