// Service discovery loads this identified agent resource alongside the other
// registry routes in this endpoints folder.
import { asServiceHandler } from '@underload/service';
import { agentDelete, agentGet, agentPut } from './registry';

// GET reads, PUT replaces the definition of, and DELETE permanently removes
// one persisted agent.
export default {
    route: '/v1/chat-assistant/agent/:agent_id',
    handler: asServiceHandler({
        GET: agentGet,
        PUT: agentPut,
        DELETE: agentDelete
    })
};
