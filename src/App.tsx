// Public application shell. The component stays intentionally small so the
// reusable dashboard remains available through src/components/index.ts.
import { ChatAssistantApp } from './components';

// Render the default chat assistant experience.
export function App() {
    return <ChatAssistantApp />;
}
