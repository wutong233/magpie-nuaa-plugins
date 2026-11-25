// Offline regression test for nuaa-responses-fix.middleware.mjs.
// No network, no credentials, no magpie: it drives the middleware directly.
import { onProvider, onEvent } from './nuaa-responses-fix.middleware.mjs';

const results = [];
const ok = (n, c, e) => results.push({ n, ok: !!c, e: e ? String(e).slice(0, 120) : undefined });

const COMPLETED = {
  type: 'response.completed',
  response: { status: 'completed', id: 'resp_1', output: [{ type: 'message' }] },
};
const NOISE = {
  type: 'error',
  error: {
    code: 'responses.incomplete_stream',
    message: 'Upstream stream ended without a terminal Responses event',
  },
};
const FAILURES = [
  ['error', { type: 'error', error: { code: 'server_error', message: 'boom' } }],
  ['response.failed', { type: 'response.failed', response: { id: 'resp_1' } }],
  ['response.incomplete', { type: 'response.incomplete', response: { id: 'resp_1' } }],
];

const mk = (over = {}) => ({
  protocol: 'responses',
  provider: { id: 'nuaa', model: 'deepseek-flash' },
  state: {},
  ...over,
});
const start = (over) => {
  const ctx = mk(over);
  onProvider({}, ctx);
  return ctx;
};

// --- scope: the Responses protocol, nothing else ------------------------
ok('active for responses + nuaa + deepseek-flash', start().state.active === true);
ok('active for another provider and model', start({ provider: { id: 'openai', model: 'gpt-5' } }).state.active === true);
ok('active with no provider object', (() => {
  const ctx = { protocol: 'responses', state: {} };
  onProvider({}, ctx);
  return ctx.state.active === true;
})());
ok('active with an unknown provider id', start({ provider: { id: 'local-llama', model: 'qwen3' } }).state.active === true);
ok('inactive on chat protocol', start({ protocol: 'chat' }).state.active === false);
ok('inactive on completions protocol', start({ protocol: 'completions' }).state.active === false);
ok('inactive without a protocol', (() => {
  const ctx = { state: {} };
  onProvider({}, ctx);
  return ctx.state.active === false;
})());
ok('flags reset on start', (() => {
  const ctx = { protocol: 'responses', state: { active: true, completed: true, failed: true } };
  onProvider({}, ctx);
  return ctx.state.completed === false && ctx.state.failed === false;
})());
ok('onProvider returns undefined', onProvider({}, mk()) === undefined);

// --- rule 1: a legal response.completed is recorded, not swallowed ------
const c1 = start();
ok('completed passes through', onEvent(COMPLETED, c1) === undefined);
ok('completed recorded', c1.state.completed === true);

for (const [label, bad] of [
  ['status not completed', { ...COMPLETED, response: { ...COMPLETED.response, status: 'incomplete' } }],
  ['empty id', { ...COMPLETED, response: { ...COMPLETED.response, id: '' } }],
  ['id not a string', { ...COMPLETED, response: { ...COMPLETED.response, id: 42 } }],
  ['output not an array', { ...COMPLETED, response: { ...COMPLETED.response, output: 'nope' } }],
  ['missing response', { type: 'response.completed' }],
]) {
  const ctx = start();
  onEvent(bad, ctx);
  ok('not recorded: ' + label, ctx.state.completed === false);
  ok('noise passes after bad completion: ' + label, onEvent(NOISE, ctx) === undefined);
}

// --- rule 2: the exact noise after a legal completion is swallowed ------
const c2 = start();
onEvent(COMPLETED, c2);
ok('noise swallowed', onEvent(NOISE, c2) === null);
ok('noise swallowed twice', onEvent(NOISE, c2) === null);

const c2b = start({ provider: { id: 'openai', model: 'gpt-5' } });
onEvent(COMPLETED, c2b);
ok('noise swallowed for another provider too', onEvent(NOISE, c2b) === null);

const c3 = start();
onEvent(COMPLETED, c3);
ok('other error code passes',
  onEvent({ type: 'error', error: { code: 'rate_limit_exceeded', message: NOISE.error.message } }, c3) === undefined);

const c4 = start();
onEvent(COMPLETED, c4);
ok('other message passes',
  onEvent({ type: 'error', error: { code: NOISE.error.code, message: 'something else entirely' } }, c4) === undefined);

const c5 = start();
onEvent(COMPLETED, c5);
ok('error without code passes', onEvent({ type: 'error', error: { message: NOISE.error.message } }, c5) === undefined);

ok('noise before completion passes', onEvent(NOISE, start()) === undefined);

// --- rule 3: a failure rejects any later completion -------------------
for (const [label, failure] of FAILURES) {
  const ctx = start();
  onEvent(failure, ctx);
  ok('failed flagged by ' + label, ctx.state.failed === true);
  const ret = onEvent(COMPLETED, ctx);
  ok('completion rejected after ' + label, ctx.state.completed === false && ret === undefined);
  ok('noise passes when completion was rejected (' + label + ')', onEvent(NOISE, ctx) === undefined);
}

// --- documented limitation (README section 4) -------------------------
// Once a completion is accepted, later failures do not retract it, so the
// noise is still swallowed. This test pins that behaviour for visibility.
for (const [label, failure] of FAILURES) {
  const ctx = start();
  onEvent(COMPLETED, ctx);
  onEvent(failure, ctx);
  ok('LIMITATION: noise still swallowed after late ' + label, onEvent(NOISE, ctx) === null);
}

// --- inactive scope is fully inert ------------------------------------
const off = start({ protocol: 'chat' });
onEvent(COMPLETED, off);
ok('inactive: completion ignored', off.state.completed === false);
ok('inactive: noise passes', onEvent(NOISE, off) === undefined);

// --- state does not leak between requests -----------------------------
const reused = mk();
onProvider({}, reused);
onEvent(COMPLETED, reused);
onProvider({}, reused); // new request, same object
ok('state reset across requests',
  reused.state.completed === false && onEvent(NOISE, reused) === undefined);

console.log(JSON.stringify(results.filter((r) => !r.ok)));
console.log('TOTAL', results.length, 'FAILED', results.filter((r) => !r.ok).length);
