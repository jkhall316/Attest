// Attest Pro: record -> diarized transcript -> summary/actions/mindmap -> ask -> export.
// Memory: structured facts per recording (memory.js) and, when the AI + VECTORS bindings
// exist, a Vectorize semantic index (vectors.js). Without them Ask uses FTS5 keywords.
// Deliberately skipped (see README): background queues.
// (Chat threads live in src/routes/chats.js; retrieval is keyword-only.)
//
// This file is the router and the Worker entry point, nothing else. Logic lives in:
//   config.js            model/transcriber catalog, upload cap
//   templates.js         88 builtin summary presets (pure data)
//   text.js              pure text helpers (markdown, html, fts, diarization)
//   speakers.js          speaker naming (#4): evidenced LLM inference + the pure rename pass
//   prompts.js           the summarize prompt
//   http.js              json/fail/uid/ownerOf
//   db.js                owner-scoped row access, template resolution
//   sources.js           which devices the owner uses (app, Pocket, Omi, pendant); drives the UI and the cron
//   access.js            Cloudflare Access service tokens for the device app (verified JWT, two routes only)
//   routes/              one module per feature area
//   zip.js, docx.js      export writers

import { MODELS, TRANSCRIBERS, VOICE_MODEL, isLocal, deprecations, modelsFor, transcribersFor, defaultModel, maxUpload } from './config.js';
import { TEMPLATES } from './templates.js';
import { json, fail, ownerOf } from './http.js';
import { readRow } from './db.js';
import { areaClause } from './areas.js';
import { VISIBLE } from './conversations.js';
import { mergeNow, undoReshape } from './routes/reshape.js';
import { effectiveStatus, safeParse } from './text.js';
import {
  upload, process as processRecording, audio, remove, voiceMatch, resummarize, setActionDone, speakerTurns, resetSpeakers, reassign,
  liveStart, liveChunk, liveAudio, livePart, liveRecover, setArea, backfillAreas, reshapeNow,
} from './routes/recordings.js';
import { listPeople, createPerson, mergePeople, renamePerson, confirmSpeaker, enrollVoiceprint, deleteVoiceprint, clearVoiceprints, listVoiceprints, voiceprintAudio, putVoiceprintEmbedding } from './routes/people.js';
import { today, brief, ackBrief, insight } from './routes/today.js';
import { backfill, listMemory, patchFact, deleteFact } from './routes/memory.js';
import { vectorsEnabled } from './vectors.js';
import { withLocalBackends } from './local.js';
import { ask, deepResearch } from './routes/ask.js';
import { listChats, createChat, readChat, deleteChat, postChatMessage } from './routes/chats.js';
import { ensureSchema } from './schema.js';
import { getTimings, addTiming } from './timings.js';
import { withSettings, getSettings, saveSettings, saveExtras } from './settings.js';
import { runScheduled } from './cron.js';
import { importPocket } from './routes/pocket.js';
import { importOmi } from './routes/omi.js';
import { sourceStates } from './sources.js';
import { verifyServiceToken, serviceTokenMayCall } from './access.js';
import { exportAll } from './routes/export.js';
import { listTemplates, createTemplate, deleteTemplate } from './routes/templates.js';

export default {
  // Cron Trigger (wrangler.toml [triggers]): memory catch-up, Pocket import and processing. Locally
  // (`npm run local`) nothing fires it by itself; GET /cdn-cgi/local/scheduled runs it once.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => withSettings(env)).then((e) => runScheduled(withLocalBackends(e))));
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    let owner = ownerOf(request);
    const m = request.method;
    const rest = pathname.startsWith('/api/recordings/') ? pathname.slice(16) : null;
    const chatRest = pathname.startsWith('/api/chats/') ? pathname.slice('/api/chats/'.length) : null;
    /* --- #14 voiceprint enrollment --- */
    const peopleRest = pathname.startsWith('/api/people/') ? pathname.slice('/api/people/'.length) : null;
    /* --- /#14 voiceprint enrollment --- */

    try {
      await ensureSchema(env);
      env = withLocalBackends(await withSettings(env)); // in-app settings (gear icon) override deploy-time config
      // Cloudflare Access sets the email header; with REQUIRE_ACCESS=true a request
      // without it is refused instead of silently becoming the shared `local` owner.
      // A device app (the pendant) comes in with an Access service token instead of a login: a verified
      // token acts as the owner, and only on the few routes a device needs.
      if (!request.headers.get('cf-access-authenticated-user-email') && env.OWNER_EMAIL) {
        const svc = await verifyServiceToken(request, env);
        if (svc) {
          if (!serviceTokenMayCall(m, pathname)) return fail('this token may only upload recordings', 403);
          owner = env.OWNER_EMAIL;
          env = { ...env, REQUIRE_ACCESS: 'false' };
        }
      }
      if (env.REQUIRE_ACCESS === 'true' && !request.headers.get('cf-access-authenticated-user-email'))
        return fail('unauthorized', 401);
      // CSRF: a cross-site page must not be able to drive writes with the owner's cookies.
      if (m !== 'GET' && m !== 'HEAD' && request.headers.get('sec-fetch-site') === 'cross-site')
        return fail('cross-site request refused', 403);

      if (pathname === '/api/meta' && m === 'GET')
        return json({
          templates: TEMPLATES, models: modelsFor(env), transcribers: transcribersFor(env),
          default_model: defaultModel(env), max_upload: maxUpload(env),
          deprecations: deprecations(),
          voice_model: VOICE_MODEL, voice_match_enabled: env.VOICE_MATCH !== 'off', vectors_enabled: vectorsEnabled(env),
          sources: sourceStates(env),
          local_mode: isLocal(env), diarize_local: isLocal(env) && String(env.LOCAL_DIARIZE) === 'true',
        });

      if (pathname === '/api/timings' && m === 'GET') return getTimings(env, owner);
      if (pathname === '/api/timings' && m === 'POST') return addTiming(request, env, owner);

      if (pathname === '/api/settings' && m === 'GET') return getSettings(env);
      if (pathname === '/api/settings' && m === 'PUT') return saveSettings(request, env, owner);
      if (pathname === '/api/settings/extras' && m === 'PUT') return saveExtras(request, env, owner);

      if (pathname === '/api/recordings' && m === 'GET') {
        const ac = areaClause(new URL(request.url).searchParams.get('area'));
        const rows = (await env.DB.prepare(
          `SELECT id, title, created_at, duration_ms, status, error, template, status_at, speakers, area, area_source, lineage
             FROM recordings WHERE owner = ?${VISIBLE}${ac.sql} ORDER BY created_at DESC LIMIT 200`
        ).bind(owner, ...ac.binds).all()).results;
        // A live recording that never finalized would otherwise show as 'recording'
        // forever; report it as abandoned instead of leaving a stuck row.
        return json({ recordings: rows.map(({ speakers, ...r }) => ({
          ...r, ...effectiveStatus(r),
          // names only, for the sidebar's avatar cluster; the full speaker rows stay on the recording
          people: [...new Set((safeParse(speakers) || []).map((x) => x?.name).filter(Boolean))],
        })) });
      }

      if (pathname === '/api/recordings' && m === 'POST') return upload(request, env, owner);
      if (pathname === '/api/recordings/areas/backfill' && m === 'POST') return backfillAreas(env, owner);
      if (pathname === '/api/recordings/merge' && m === 'POST') return mergeNow(request, env, owner);

      /* --- #7 live transcription --- */
      // Collection route (exact pathname), checked ahead of the generic /:id routes
      // below so a recording id can never collide with the literal segment "live".
      if (pathname === '/api/recordings/live' && m === 'POST') return liveStart(request, env, owner);
      /* --- /#7 live transcription --- */

      if (pathname === '/api/today' && m === 'GET') return today(request, env, owner);
      if (pathname === '/api/today/brief' && m === 'POST') return brief(request, env, owner);
      if (pathname === '/api/today/ack' && (m === 'POST' || m === 'DELETE')) return ackBrief(request, env, owner);
      if (pathname === '/api/insight' && m === 'POST') return insight(request, env, owner);

      if (pathname === '/api/memory' && m === 'GET') return listMemory(request, env, owner);
      if (pathname === '/api/memory/backfill' && m === 'POST') return backfill(env, owner);
      if (pathname.startsWith('/api/memory/') && m === 'PATCH') return patchFact(request, env, owner, pathname.slice('/api/memory/'.length));
      if (pathname.startsWith('/api/memory/') && m === 'DELETE') return deleteFact(env, owner, pathname.slice('/api/memory/'.length));

      if (pathname === '/api/pocket/import' && m === 'POST') return await importPocket(request, env, owner); // await, so an error thrown inside reaches the catch below
      if (pathname === '/api/omi/import' && m === 'POST') return await importOmi(request, env, owner);

      if (pathname === '/api/templates' && m === 'GET')
        return json({ templates: await listTemplates(env, owner) });

      if (pathname === '/api/templates' && m === 'POST') return createTemplate(request, env, owner);

      if (pathname.startsWith('/api/templates/') && m === 'DELETE')
        return deleteTemplate(env, owner, pathname.slice('/api/templates/'.length));

      if (pathname === '/api/people' && m === 'GET') return listPeople(env, owner, new URL(request.url).searchParams.get('area'));

      if (pathname === '/api/people' && m === 'POST') return createPerson(request, env, owner);

      if (pathname === '/api/people/merge' && m === 'POST') return mergePeople(request, env, owner);

      /* --- #14 voiceprint enrollment --- */
      if (peopleRest && !peopleRest.includes('/') && m === 'PATCH')
        return renamePerson(request, env, owner, peopleRest);

      if (peopleRest && peopleRest.endsWith('/voiceprint') && m === 'POST')
        return enrollVoiceprint(request, env, owner, peopleRest.slice(0, -'/voiceprint'.length));

      if (peopleRest && peopleRest.endsWith('/voiceprints') && m === 'DELETE')
        return clearVoiceprints(env, owner, peopleRest.slice(0, -'/voiceprints'.length));

      if (pathname === '/api/voiceprints' && m === 'GET') return listVoiceprints(env, owner);

      if (pathname.startsWith('/api/voiceprints/') && pathname.endsWith('/audio') && m === 'GET')
        return voiceprintAudio(env, owner, pathname.slice('/api/voiceprints/'.length, -'/audio'.length));

      if (pathname.startsWith('/api/voiceprints/') && pathname.endsWith('/embedding') && m === 'PUT')
        return putVoiceprintEmbedding(request, env, owner, pathname.slice('/api/voiceprints/'.length, -'/embedding'.length));

      if (pathname.startsWith('/api/voiceprints/') && m === 'DELETE')
        return deleteVoiceprint(env, owner, pathname.slice('/api/voiceprints/'.length));
      /* --- /#14 voiceprint enrollment --- */

      if (pathname === '/api/chats' && m === 'GET') return json({ chats: await listChats(env, owner) });

      if (pathname === '/api/chats' && m === 'POST') return createChat(request, env, owner);

      if (chatRest && chatRest.endsWith('/messages') && m === 'POST')
        return postChatMessage(request, env, owner, chatRest.slice(0, -'/messages'.length));

      if (chatRest && m === 'GET') {
        const found = await readChat(env, chatRest, owner);
        return found ? json(found) : fail('not found', 404);
      }

      if (chatRest && m === 'DELETE') return deleteChat(env, chatRest, owner);

      if (rest && rest.endsWith('/audio') && m === 'GET')
        return audio(env, rest.slice(0, -'/audio'.length), owner, request);

      /* --- #7 live transcription --- */
      // /:id/live and /:id/audio are sub-routes of a recording id, so they must be
      // checked (by method + suffix) before the generic /:id GET/DELETE below.
      if (rest && rest.endsWith('/live') && m === 'POST')
        return liveChunk(request, env, owner, rest.slice(0, -'/live'.length));

      if (rest && rest.endsWith('/audio') && m === 'PUT')
        return liveAudio(request, env, owner, rest.slice(0, -'/audio'.length));
      /* --- /#7 live transcription --- */

      if (rest && rest.endsWith('/part') && m === 'POST')
        return livePart(request, env, owner, rest.slice(0, -'/part'.length));

      if (rest && rest.endsWith('/recover') && m === 'POST')
        return liveRecover(env, owner, rest.slice(0, -'/recover'.length));

      if (rest && rest.endsWith('/process') && m === 'POST')
        return json(await processRecording(env, rest.slice(0, -'/process'.length), owner,
          { stopAfter: new URL(request.url).searchParams.get('stop_after') === 'transcript' ? 'transcript' : undefined,
            force: new URL(request.url).searchParams.get('force') === '1' }));

      if (rest && rest.endsWith('/voice-match') && m === 'POST')
        return voiceMatch(request, env, owner, rest.slice(0, -'/voice-match'.length));

      if (rest && rest.endsWith('/reassign') && m === 'POST')
        return reassign(request, env, owner, rest.slice(0, -'/reassign'.length));

      if (rest && rest.endsWith('/speaker-turns') && m === 'POST')
        return speakerTurns(request, env, owner, rest.slice(0, -'/speaker-turns'.length));

      if (rest && rest.endsWith('/reset-speakers') && m === 'POST')
        return resetSpeakers(env, owner, rest.slice(0, -'/reset-speakers'.length));

      if (rest && rest.endsWith('/resummarize') && m === 'POST')
        return resummarize(env, rest.slice(0, -'/resummarize'.length), owner);

      if (rest && rest.endsWith('/reshape') && m === 'POST')
        return reshapeNow(env, owner, rest.slice(0, -'/reshape'.length));

      if (rest && rest.endsWith('/undo-reshape') && m === 'POST')
        return undoReshape(env, owner, rest.slice(0, -'/undo-reshape'.length));

      if (rest && rest.endsWith('/area') && m === 'PATCH')
        return setArea(request, env, owner, rest.slice(0, -'/area'.length));

      if (rest && rest.endsWith('/actions') && m === 'PATCH')
        return setActionDone(request, env, owner, rest.slice(0, -'/actions'.length));

      if (rest && rest.endsWith('/speakers') && m === 'PATCH')
        return confirmSpeaker(request, env, owner, rest.slice(0, -'/speakers'.length));

      // generic id routes last, so /audio, /process, /speakers, /live and the PUT
      // on /audio are not swallowed by them
      if (rest && m === 'GET') {
        const r = await readRow(env, rest, owner);
        return r ? json(r) : fail('not found', 404);
      }

      if (rest && m === 'DELETE') return remove(env, rest, owner);

      if (pathname === '/api/ask' && m === 'POST') {
        const { question, mode, area } = await request.json().catch(() => ({}));
        if (!question || typeof question !== 'string') return fail('question required');
        /* --- #3 deep research --- */
        return json(mode === 'deep' ? await deepResearch(env, owner, question, [], area) : await ask(env, owner, question, area));
        /* --- /#3 deep research --- */
      }

      if (pathname === '/api/export' && m === 'GET') {
        const sp = new URL(request.url).searchParams;
        return exportAll(env, owner, sp.get('id'), sp.get('format') || 'md', sp.get('area'));
      }

      return fail('not found', 404);
    } catch (e) {
      return fail(String(e?.message || e), e?.status || 500);
    }
  },
};
