// VOICE plugin: the composer's voice-to-text session.
//
// WHAT THIS PLUGIN IS: the dashboard half of src/api/speech.ts. It publishes the
// `chat.speech` service (the promise-first client over the Web Speech API, see
// ../services/speech.ts) and ports the oracle's toggle exactly
// (components/ChatAssistantApp.tsx:4174-4270):
//
//   start  pre-check -> capture the draft snapshot -> listening ON -> one
//          recognition session whose CUMULATIVE frames rewrite
//          `snapshot + latest frame` into `chat.draft` (never stacking, so
//          pre-typed words survive and interim frames replace each other),
//          and a FINISHED utterance submits itself through `chat.message.send`
//          exactly like a typed message — gated on the session having produced
//          at least one transcript frame.
//   stop   explicit teardown: the partial transcript STAYS in the draft for
//          review and a MANUAL send, and never auto-fires.
//
// THE THREE ADAPTATIONS this build makes, each deliberate:
//   1. PRE-CHECKS via the client. The oracle probes `speechRecognitionSupported()`
//      then `speechContextSecure()` in that order, so an origin that is BOTH
//      API-less and insecure reports the true cause (:4184-4205). `SpeechClient
//      .start()` performs the same two probes in the same order and REJECTS with
//      the actionable message for each (services/speech.ts:77-84), so one await
//      covers both and the rejection text goes straight into `chat.error`.
//   2. THE AUTO-SEND SEAM IS `onFinal`. `SpeechClientHandlers` has no `onEnd`
//      channel (services/speech.ts:45-54), and api/speech.ts always delivers the
//      settled final text BEFORE it settles the session (:248-254), so the final
//      frame is the same instant the oracle's onEnd fired its auto-send from. The
//      only behaviour that needs an `onEnd` channel is an engine that ends after
//      INTERIM frames without ever delivering a final one; those endings are the
//      benign ones api/speech.ts suppresses, and this plugin leaves the interim
//      text in the composer for a manual send instead of guessing.
//   3. THE R7 GUARD. A mode switch mid-utterance lands on a NEW namespace, so the
//      auto-send is dropped when the pair captured at session start no longer
//      matches (the text stays in the draft, which the core deliberately preserves
//      across a mode switch, plugins/core.ts:528-531).
//   4. A SEND HALTS THE ENGINE. The oracle's `submit()` disposes the recognizer at
//      the top of the flow (:3874-3879) so the transcript it already wrote is
//      exactly what gets sent and nothing rewrites the composer during the provider
//      round-trip. The rebuild does the same from both ends: `plugins/source.ts`
//      runs `chat.voice.stop` as the first thing `send()` does, and this plugin
//      halts itself on `chat.stream.started` so ANY other producer of a stream gets
//      the same teardown. Each retired session carries a generation number, and the
//      engine handlers compare it before touching a cell — that is what makes a
//      frame the engine delivers after the halt (or a second FINAL frame from a
//      continuous engine) neither rewrite `chat.draft` nor dispatch a second send.
//
// NO REACT, NO JSX. Everything browser-shaped goes through the injected client, so
// an API-less host (jsdom, Firefox, an embedded webview) fails the pre-check and
// never touches a `SpeechRecognition` global.
import type { DashboardPlugin } from '@underload/dashboard';
import { appendTranscript, speechDeniedDetail } from '../../api/speech';
import {
    CHAT_CELLS_SERVICE,
    CHAT_EPOCH_SERVICE,
    CHAT_ERROR_EVENT,
    CHAT_MESSAGE_SEND_COMMAND,
    CHAT_SPEECH_SERVICE,
    CHAT_STREAM_STARTED_EVENT,
    CHAT_VOICE_START_COMMAND,
    CHAT_VOICE_STOP_COMMAND,
    PLUGIN_IDS,
    type ChatCells,
    type ChatEpoch,
    type NoticeEvent,
    type StreamStartedEvent
} from '../contract';
import { createSpeechClient, type SpeechClient, type SpeechHandle } from '../services/speech';
import { readableFailure } from './source';

// The one engine label this plugin re-diagnoses: api/speech.ts maps
// 'not-allowed'/'service-not-allowed' to this exact display string
// (src/api/speech.ts:102-114), and the oracle swaps it for the self-diagnosing
// cause because a SILENT denial (no prompt at all) is almost always the serving
// origin or a sticky site-level block, not something the generic label explains
// (components/ChatAssistantApp.tsx:4236-4244).
export const MICROPHONE_DENIED_LABEL = 'Microphone access was denied.';

export type VoicePluginOptions = {
    /**
     * The speech client to drive. Defaults to `createSpeechClient()` (the real Web
     * Speech API through ../services/speech.ts); a test injects a double and never
     * touches a browser global.
     */
    speech?: SpeechClient;
};

export function createVoicePlugin(options: VoicePluginOptions = {}): DashboardPlugin {
    // Resolved once: the service registry freezes values at setup, and the engine has
    // no configuration to re-read (the page language is inherited per session,
    // services/speech.ts:70-72).
    const speech = options.speech ?? createSpeechClient();

    return {
        id: PLUGIN_IDS.chatVoice,
        // The cells handle is read during setup and the send/cancel commands exist
        // once chat.source has run; the edge below is what makes the setup-time
        // `getService` defined rather than a lucky coincidence.
        requires: [PLUGIN_IDS.chatCore],
        setup(api) {
            const cells = api.getService<ChatCells>(CHAT_CELLS_SERVICE);
            const epoch = api.getService<ChatEpoch>(CHAT_EPOCH_SERVICE);
            api.service<SpeechClient>(CHAT_SPEECH_SERVICE, speech);

            let alive = true;
            // The ONE live session (the oracle's `recognizer` ref). A handle, not a
            // cell: `chat.listening` is the observable half, the handle is the
            // teardown half.
            let session: SpeechHandle | null = null;
            /**
             * Monotonic session identity. `start()` takes the next number for the
             * session it opens and every engine handler of THAT session compares it
             * against the live one; `release()` advances it, which is what silences a
             * stopped engine's callbacks. Without it, a frame delivered after a halt
             * (the send below tears the engine down, and a real `SpeechRecognition`
             * may still have a result event queued) would rewrite `chat.draft` under a
             * conversation that already moved on — and a late FINAL frame would fire a
             * second auto-send. The oracle is immune by construction because `submit()`
             * calls `recognizer().dispose()` (:3874-3879), which detaches the callbacks
             * inside the engine object itself.
             */
            let generation = 0;
            // The append base every frame of the CURRENT session rewrites onto (the
            // oracle's `speechDraft` ref, :4211). A plain variable, not a cell: it is
            // read only from engine callbacks, and a cell write per frame would put
            // the interim delivery into the re-render race (:4206-4212).
            let speechDraft = '';
            // The auto-send gate (the oracle's `voiceTranscript` ref, :4203): true once
            // ANY frame — interim or final — has carried speakable text, so a session
            // that ended without hearing anything never sends the stale pre-typed
            // draft.
            let heard = false;

            // ——— the failure seam ———————————————————————————————————————————————
            // One place writes a voice failure: the cell (the stage's `error-banner`)
            // plus the event pair every other chat plugin reports with
            // (plugins/sessions.ts:152-154). `chat.notices` keeps the last message.
            const report = (message: string): void => {
                const text = (message ?? '').trim();
                if (!text) return;
                cells.error.set(text);
                const notice: NoticeEvent = { message: text };
                api.emit(CHAT_ERROR_EVENT, notice);
            };

            // ——— the session helpers —————————————————————————————————————————————
            /**
             * Tear the current handle down without surfacing anything (a stop, a halt
             * for a send, or teardown). Advancing `generation` FIRST is the part that
             * matters: it retires the session's handlers before the engine is touched,
             * so a callback the engine fires on the way out is already a no-op.
             */
            const release = (): void => {
                generation += 1;
                const live = session;
                session = null;
                try {
                    live?.stop();
                } catch {
                    // A teardown that cannot reach the engine still drops the surface:
                    // the handle's own dispose guard makes a late frame a no-op.
                }
            };

            /** Turn the mic chrome off, but only while this plugin still owns a cell. */
            const stopListening = (): void => {
                if (alive) cells.listening.set(false);
            };

            /**
             * Rewrite the draft with the session's CUMULATIVE frame. Both frame kinds
             * use the same rule (api/speech.ts delivers cumulative text for interim AND
             * final, src/api/speech.ts:231-255), and `appendTranscript` owns the
             * single-space separator (src/api/speech.ts:171-175).
             */
            const applyFrame = (text: string): void => {
                heard = true;
                cells.draft.set(appendTranscript(speechDraft, text));
            };

            // ——— the toggle ——————————————————————————————————————————————————————
            const start = async (): Promise<void> => {
                if (!alive) return;
                // Already listening: a second start is the same explicit STOP the
                // button's off-branch performs (the oracle keeps the recognized text
                // for review and never auto-sends it, :4175-4182). Without this guard
                // a double tap would open a second engine session on one surface.
                if (session !== null || cells.listening.get()) {
                    release();
                    stopListening();
                    return;
                }

                // Snapshot BEFORE the session exists: the session identity, the
                // namespace guard, the draft append base, and the gate reset — the
                // PREVIOUS session's frame marker must not bleed into this one
                // (:4206-4213). The handlers below close over `sessionGeneration` and
                // `guard`, which is what makes a halted session's callbacks inert and
                // keeps the auto-send pointed at the namespace that started it.
                const sessionGeneration = ++generation;
                const guard = epoch.capture();
                speechDraft = cells.draft.get();
                heard = false;

                /**
                 * The per-session liveness gate. Every handler opens with it, because
                 * three things can retire a session while its engine is still talking:
                 * `dispose()` runs the plugin teardown and an engine frame still in
                 * flight would otherwise write a DETACHED cell (a disposed cell's `set`
                 * throws 'disposed', packages/underload/dashboard/src/extensions/
                 * state.ts) and dispatch `chat.message.send` against a command registry
                 * that no longer exists; an explicit stop discards the session silently;
                 * and a SEND halts the engine mid-utterance (see the
                 * `chat.stream.started` subscription and the head of `send()` in
                 * plugins/source.ts — the oracle's `submit()` head, :3874-3879).
                 */
                const owned = (): boolean => alive && generation === sessionGeneration;

                const onInterim = (text: string): void => {
                    if (!owned()) return;
                    applyFrame(text);
                };

                const onFinal = (text: string): void => {
                    if (!owned()) return;
                    applyFrame(text);
                    // The settled utterance ends the session (api/speech.ts:248-254 fires
                    // its single onEnd right after this frame), so the chrome comes off
                    // here — the seam the client exposes for the oracle's onEnd.
                    // `release()`, not a bare `session = null`: the engine is still
                    // attached at this instant, and the auto-send below is exactly the
                    // moment the oracle's `submit()` tears it down. Left attached, a
                    // continuous-engine frame rewrites the draft the send has just
                    // cleared, and a second FINAL frame dispatches a SECOND send.
                    release();
                    stopListening();
                    // AUTO-SEND, gated exactly as the oracle gates it: only a session that
                    // actually produced a frame submits, and only into the namespace that
                    // started it (adaptation 3 above). `chat.message.send` keeps its own
                    // guards (blank draft, no model, a stream already running), so a
                    // blocked send leaves the text in the composer for a manual send.
                    if (heard && epoch.namespaceCurrent(guard)) {
                        api.execute<void>(CHAT_MESSAGE_SEND_COMMAND);
                    }
                };

                const onError = (detail: string): void => {
                    if (!owned()) return;
                    // A real engine failure ends the session (the api fires onError then
                    // settles, src/api/speech.ts:256-264), so the chrome drops either way.
                    release();
                    stopListening();
                    if ((detail ?? '') === MICROPHONE_DENIED_LABEL) {
                        // SILENT denial: replace the generic label with the diagnosed
                        // cause (HTTPS/localhost, a sticky site block, or a missing embed
                        // permission) — the oracle's swap, :4241-4244. The probe is async
                        // and must never land in a namespace the operator has left.
                        const deniedUnder = guard;
                        void speechDeniedDetail().then((cause: string) => {
                            if (alive && epoch.namespaceCurrent(deniedUnder)) report(cause);
                        });
                        return;
                    }
                    report(detail);
                };

                // The oracle raises the chrome and clears the banner synchronously,
                // before the engine exists (:4213-4214), and rolls the chrome back when
                // the engine refuses (:4266-4269). Same order here: a rejected
                // pre-check resolves in one microtask, so nothing paints in between.
                cells.listening.set(true);
                cells.error.set('');

                let handle: SpeechHandle;
                try {
                    handle = await speech.start({ onInterim, onFinal, onError });
                } catch (reason) {
                    // Pre-check failure (no API at all, or an insecure context): the
                    // actionable text from services/speech.ts:67-84 becomes the banner.
                    release();
                    stopListening();
                    if (alive && epoch.namespaceCurrent(guard)) report(readableFailure(reason));
                    return;
                }

                // Three things may have happened while the session was opening: a frame
                // may have settled it inside `start()` (an engine — or a test double —
                // that delivers its final frame synchronously), a mode switch may have
                // landed, or a send may have HALTED it. Either way nothing is live to
                // keep: drop the handle, take the chrome off, and never report a failure
                // the operator did not cause.
                const superseded = !epoch.namespaceCurrent(guard);
                const halted = generation !== sessionGeneration;
                if (superseded || halted || !handle.active || !alive) {
                    try {
                        handle.stop();
                    } catch {
                        // Teardown of a session that never became live.
                    }
                    if (alive) {
                        session = null;
                        // `!handle.active` covers a session that already settled inside
                        // `start()`: its onFinal cleared the chrome, and clearing it
                        // again is an equal write (no notification).
                        if (superseded || halted || !handle.active) stopListening();
                    }
                    return;
                }
                session = handle;
            };

            const stop = (): boolean => {
                const live = session;
                // An explicit stop discards the session SILENTLY (the client's
                // `stop()` disposes the engine's callbacks, services/speech.ts:116-125),
                // so the partial transcript stays in the draft for review and the
                // auto-send never fires.
                release();
                stopListening();
                // False = nothing was live, which is what makes a double tap cheap to
                // reason about from a control's handler.
                return live !== null;
            };

            api.command<void, Promise<void>>(CHAT_VOICE_START_COMMAND, () => start());
            api.command<void, boolean>(CHAT_VOICE_STOP_COMMAND, () => stop());

            /**
             * A stream starting means the composer belongs to the conversation, not to
             * the microphone: halt the live session (S1). This is the contract-level
             * twin of the oracle's `submit()` head, which disposes the recognizer before
             * the provider round-trip (:3874-3879) so the engine cannot rewrite the
             * draft while the turn is in flight.
             *
             * the oracle's `submit()` head, which disposes the recognizer before
             * the provider round-trip (:3874-3879) so the engine cannot rewrite the
             * draft while the turn is in flight.
             *
             * WHY THE EVENT RATHER THAN ONLY A CALL FROM `send()`: every producer of a
             * stream lands on this event — the composer's Enter/submit, the voice
             * auto-send, and any add-on that dispatches `chat.message.send` — so no
             * caller has to know the microphone exists. `plugins/source.ts` additionally
             * halts at the HEAD of `send()`, because the draft is read and cleared
             * BEFORE this event is emitted (an online new chat creates the record
             * first, source.ts:525-550), and the oracle halts before reading the text
             * at all. Both halves are idempotent: the second one sees no session.
             *
             * `release()` (silent teardown) is the right call, not `stop()`: the
             * transcript the engine already wrote IS the text being sent, and halting
             * never re-fires the auto-send.
             */
            const onStreamStarted = api.on<StreamStartedEvent>(
                CHAT_STREAM_STARTED_EVENT,
                (): void => {
                    if (!alive) return;
                    release();
                    stopListening();
                }
            );

            return () => {
                // Teardown first flips `alive` so no late engine frame writes to a
                // DETACHED cell (a disposed cell's `set` throws 'disposed',
                // packages/underload/dashboard/src/extensions/state.ts). The session
                // then goes quietly: the component that owned the mic is gone.
                alive = false;
                onStreamStarted();
                release();
            };
        }
    };
}

/** The default-configured voice plugin (real Web Speech API client). */
export const voicePlugin: DashboardPlugin = createVoicePlugin();
