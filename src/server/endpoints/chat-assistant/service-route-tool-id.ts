// Service discovery loads this identified tool resource alongside the other
// registry routes in this endpoints folder.
import { asServiceHandler } from '@underload/service';
import { toolDelete, toolGet, toolPut } from './registry';

// GET reads, PUT replaces the definition of, and DELETE permanently removes
// one persisted tool.
export default {
    route: '/v1/chat-assistant/tool/:tool_id',
    handler: asServiceHandler({
        GET: toolGet,
        PUT: toolPut,
        DELETE: toolDelete
    })
};
