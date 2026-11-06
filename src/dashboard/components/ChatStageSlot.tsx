// ChatStageSlot — the STAGE region's slot contribution (T6, the real surface).
//
// WHY A WRAPPER EXISTS AT ALL: one component owns one region column (the shell
// renders only the LAST contribution of a channel, see pickRegionOwner in
// ../WorkstationShell.tsx), and the stage already has an owner — ChatStage
// (./ChatStage.tsx) owns the single scroll container, the follow/jump scroll
// behaviour, the `error-banner` and the composer. The transient notice strip is
// the second surface that belongs in this column, so the two are composed HERE
// rather than by editing ChatStage's tree or by contributing to the same channel
// twice (a second contribution would silently delete the first).
//
// ORDER (NoticeStrip first, then ChatStage): a consequence row reads best ABOVE
// the log it describes — the strip reports "Forked 4 messages into a new
// conversation." / "System prompt saved." / the mode-switch consequence, all of
// which explain what just happened to the transcript below. The actionable
// failure stays where it was: `chat.error` renders INSIDE ChatStage, between the
// log and the composer (ChatStage.tsx:317-324), so a retry can be typed without
// the banner covering the transcript. The two strips are disjoint by contract —
// the banner owns `error-banner`, this strip owns `notice-strip` (see the header
// note in ../contract.ts and styles/notices.css:10-14).
//
// LAYOUT: the wrapper is a plain flex column (styles/base.css, "Region owners").
// NoticeStrip returns null on an empty feed (NoticeStrip.tsx:43), so nothing is
// reserved when there is nothing to say and `.stage` keeps the full height of the
// viewport-locked column.
import { ChatStage } from './ChatStage';
import { NoticeStrip } from './NoticeStrip';

export function ChatStageSlot() {
    return (
        <div className="stage-slot" data-testid="stage-slot">
            {/* First child: the transient strip. Absent (null) unless
                plugins/notices.ts has a row on the feed. */}
            <NoticeStrip />
            {/* The stage's real owner: transcript + error strip + composer. */}
            <ChatStage />
        </div>
    );
}
