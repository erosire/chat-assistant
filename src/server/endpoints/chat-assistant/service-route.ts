// Service discovery loads every service-route*.ts module below an endpoints folder.
import { asServiceHandler } from '@underload/service';
import { conversationCreate } from './chat-assistant';

// The collection exposes POST only because conversations are read through their
// returned identifier and never through an undocumented collection GET.
export default {
    route: '/v1/chat-assistant/conversation',
    handler: asServiceHandler({
        POST: conversationCreate
    })
};
