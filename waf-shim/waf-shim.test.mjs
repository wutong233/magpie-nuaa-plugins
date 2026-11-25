import { onRequest } from './waf-shim.hooks.mjs';
const LT = String.fromCharCode(0x3c), GT = String.fromCharCode(0x3e);
const TOK = LT + 'module' + GT;
const results = [];
const ok = (n, c, e) => results.push({ n, ok: !!c, e: e ? String(e).slice(0, 120) : undefined });

const rBody = {
  model: 'deepseek-flash', stream: true,
  tools: [{ type: 'function', name: 'x', description: 'has ' + TOK }],
  instructions: 'You are a bot.',
  input: [{ role: 'user', content: 'hi' }, { role: 'user', content: 'in ' + TOK }],
};
const calls = [];
const out = await onRequest(structuredClone(rBody), { provider: { id: 'nuaa' }, options: {}, report: (c, n) => calls.push([c, n]) });
ok('obj', out && typeof out === 'object');
ok('rewritten', !JSON.stringify(out.input).includes(TOK));
ok('replacement', JSON.stringify(out.input).includes('module_'));
ok('notice first item is system', out.input[0].role === 'system' && out.input[0].content.includes('waf-shim'));
ok('notice clean of token', !out.input[0].content.includes(TOK));
ok('history preserved', out.input.length === 3 && out.input[2].content.includes('module_'));
ok('tools untouched', JSON.stringify(out.tools) === JSON.stringify(rBody.tools));
ok('stream untouched', out.stream === true);
ok('report ready', calls.length === 1 && calls[0][0] === 'ready');

const cBody = { model: 'm', messages: [{ role: 'user', content: 'in ' + TOK }] };
const o2 = await onRequest(structuredClone(cBody), { options: {} });
ok('chat rewritten', !JSON.stringify(o2.messages).includes(TOK));
ok('chat system first', o2.messages[0].role === 'system' && o2.messages[0].content.includes('waf-shim'));
ok('chat len', o2.messages.length === 2);

const sBody = { model: 'm', input: 'in ' + TOK };
const o3 = await onRequest(structuredClone(sBody), { options: {} });
ok('string input wrapped', Array.isArray(o3.input) && o3.input[0].role === 'system' && o3.input[1].role === 'user');

ok('clean -> undefined', (await onRequest({ model: 'm', input: 'hello' }, { options: {} })) === undefined);
const o4 = await onRequest(structuredClone(cBody), { options: { notice: false } });
ok('notice:false', o4.messages.length === 1 && !JSON.stringify(o4).includes('waf-shim'));
const o5 = await onRequest({ model: 'm', input: 'a XSS b' }, { options: { rules: [{ id: 'x', match: 'XSS', flags: 'g', replace: 'X_S_S', legend: 'the script probe' }] } });
ok('custom rule', JSON.stringify(o5.input).includes('a X_S_S b'));
ok('scope skip', (await onRequest({ model: 'm', input: TOK }, { provider: { id: 'other' }, options: { providers: ['nuaa'] } })) === undefined);
ok('scope act', (await onRequest({ model: 'm', input: TOK }, { provider: { id: 'nuaa' }, options: { providers: ['nuaa'] } })) !== undefined);
ok('null', (await onRequest(null, {})) === undefined);
ok('array', (await onRequest([], {})) === undefined);
const o8 = await onRequest({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: 'in ' + TOK }] }] }, { options: {} });
ok('content array', !JSON.stringify(o8.input).includes(TOK));
console.log(JSON.stringify(results.filter(r => !r.ok)));
console.log('TOTAL', results.length, 'FAILED', results.filter(r => !r.ok).length);

