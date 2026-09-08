// Service discovery loads this agent collection route alongside the other
// registry routes in this endpoints folder.
import { asServiceHandler } from '@underload/service';
import { agentCreate, agentList } from './registry';

// The agent collection exposes GET for the persisted agent list (complete
// records — agents are small configuration documents, no transcript bodies)
// and POST for creation; definition replacement lives on the identified
// resource in service-route-agent-id.ts.
export default {
    route: '/v1/chat-assistant/agent',
    handler: asServiceHandler({
        GET: agentList,
        POST: agentCreate
    })
};
