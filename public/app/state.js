// One mutable object instead of a dozen module-level `let`s scattered across files.
// Modules import `state` and read/write fields directly; there is no reactivity here
// and none is needed — every mutation is followed by an explicit render call.

export const state = {
  META: null,          // /api/meta payload
  recordings: [],      // the sidebar list, newest first
  TPL: null,           // builtin + custom template map
  current: null,       // open recording id
  currentChat: null,   // open chat id
  pendingPrompt: null, // a prompt picked in the command palette, applied when Today renders
  screen: 'today',     // which top-level screen is showing: 'today' | 'ask' (a recording sets `current`)

  // recorder
  stream: null,
  recorder: null,
  chunks: [],
  startedAt: 0,
  tick: null,

  // in-flight guards
  asking: false,
  chatSending: false,

  // #7 live transcription: liveId is set once /recordings/live creates the row;
  // liveQueue serializes per-chunk posts so a slow one cannot let a later chunk's
  // text land first.
  liveId: null,
  liveQueue: Promise.resolve(),
};
