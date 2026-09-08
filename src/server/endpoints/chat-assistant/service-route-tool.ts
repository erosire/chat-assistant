// Service discovery loads this tool collection route alongside the other
// registry routes in this endpoints folder.
import { asServiceHandler } from '@underload/service';
import { toolCreate, toolList } from './registry';

// The tool collection exposes GET for the persisted tool list (complete
// records, including the JavaScript/TypeScript source of coded tools) and
// POST for creation; definition replacement lives on the identified resource
// in service-route-tool-id.ts.
export default {
    route: '/v1/chat-assistant/tool',
    handler: asServiceHandler({
        GET: toolList,
        POST: toolCreate
    })
};
