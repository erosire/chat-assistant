// Mic (voice input): the capsule microphone body on the shared 24x24 stroke
// grid with its cradle arc and stand stroke (Lucide "mic" geometry, converted
// to the family's path-only convention). Consumed by the composer's voice
// toggle (ChatAssistantApp's VoiceButton, docked at the input's LEFT edge):
// the glyph swaps to CloseIcon (X) while a recognition session is live, so
// the control reads as mic-when-idle, stop-while-listening.
import React from 'react';
import { IconBase, type IconProps } from './IconBase';

export const MicIcon = (props: IconProps) => (
    <IconBase name="mic" {...props}>
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <path d="M12 19v3" />
    </IconBase>
);