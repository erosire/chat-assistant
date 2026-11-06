// VoiceButton — the voice-to-text toggle docked at the composer input's left edge.
//
// Presentational + command dispatch, nothing else: the recognizer lifecycle
// (start/stop, transcripts landing in `chat.draft`, the finished-utterance
// auto-send, the "not supported in this browser" diagnosis) belongs to the chat
// plugin behind `chat.voice.start` / `chat.voice.stop`. The oracle's wiring is
// src/components/ChatAssistantApp.tsx:4174-4270 and its render site 5205-5221;
// this component reproduces only the render contract:
//
//   listening === false -> mic glyph, label "Start voice input", aria-pressed false
//   listening === true  -> stop X glyph, label "Stop voice input", aria-pressed true
//
// and the rule that the mic is ALWAYS visible (unlike the focus-gated send
// arrow): on a phone, tapping the input first would just summon the keyboard.
import { CHAT_LISTENING_STATE, CHAT_VOICE_START_COMMAND, CHAT_VOICE_STOP_COMMAND } from '../contract';
import { useDashboardValue } from '../state-hooks';
import { useWorkbench } from '../workbench';
import { CloseIcon, MicIcon } from '../../icons';

export function VoiceButton() {
    const instance = useWorkbench();
    const listening = useDashboardValue<boolean>(CHAT_LISTENING_STATE);

    const label = listening ? 'Stop voice input' : 'Start voice input';

    return (
        <button
            type="button"
            className={listening ? 'composer__voice is-active' : 'composer__voice'}
            // aria-pressed makes the live state readable without a live region;
            // the icon swap alone would not be announced.
            aria-pressed={listening}
            aria-label={label}
            title={label}
            data-listening={listening}
            data-testid="voice-button"
            onClick={() => {
                // Explicit stop keeps the partial transcript in the draft for
                // review (oracle 4175-4182); starting a session is the plugin's
                // business.
                instance.execute<void>(listening ? CHAT_VOICE_STOP_COMMAND : CHAT_VOICE_START_COMMAND);
            }}
        >
            {listening ? <CloseIcon size={16} /> : <MicIcon size={16} />}
        </button>
    );
}
