// Test-only re-exports. They live here, not in index.js, because a Worker entry module may
// only export its handlers (extra named exports break `wrangler dev`).
export { TEMPLATES } from './templates.js';
export { MODELS, TRANSCRIBERS, modelById, transcriberById, deprecationState, deprecations, liveTranscriberId } from './config.js';
export {
  diarizeToText, ftsQuery, recordingToMarkdown, recordingToHtml,
  safeFilename, chatTitleFrom, historyToMessages, effectiveStatus, STALE_RECORDING_MS, STALE_PROCESSING_MS,
} from './text.js';
/* --- #7 live transcription --- */
export { appendLive } from './text.js';
/* --- /#7 live transcription --- */
export { applySpeakerNames, filterSpeakerGuess, nameSpeakers, rebuildTranscript, anonymousSpeakers, reassignSegments } from './speakers.js';
/* --- #14 voiceprint enrollment --- */
export {
  encodeWav, pickClipWindow, wavDurationMs, matchedSpeakerRefs,
  MIN_VOICEPRINT_MS, MAX_VOICEPRINT_MS, normalizeEmbedding, cosine, matchVoices, applyVoiceMatches,
} from './voiceprints.js';
/* --- /#14 voiceprint enrollment --- */
export { buildSystemPrompt } from './prompts.js';
export { retrieve, answer } from './routes/ask.js';
/* --- #3 deep research --- */
export { deepResearch, mergeHits, excerpt, MAX_SUB_QUESTIONS, MAX_HITS, MAX_MODEL_CALLS } from './routes/ask.js';
/* --- /#3 deep research --- */
export { listTemplates } from './routes/templates.js';

export { validDate, weekStart, openItems, talkStats, involves, buildContext, insightSystem, AUTO_PROMPTS } from './insights.js';
export { normalizeFacts, chunkText, buildChunks, FACT_KINDS } from './memory.js';
export { chunksToHits, vectorsEnabled, ownerNamespace } from './vectors.js';
export { suggestMerges, renameSpeaker, mergeAliases } from './people.js';
export { parseJsonLoose } from './text.js';
export { contextChars, isLocal, maxUpload } from './config.js';
export { localEmbedder, d1Vectors, withLocalBackends, encodeVec, decodeVec, normalize } from './local.js';
export { localSegments } from './stt.js';
