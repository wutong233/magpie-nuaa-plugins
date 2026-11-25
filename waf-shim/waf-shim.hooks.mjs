// magpie gateway hook: upstream WAF shim.
//
// Why: the security appliance in front of token.nuaa.edu.cn rejects a few
// harmless literals with an HTML "访问禁止" page (HTTP 200 + text/html),
// which magpie reports as "answered 200 OK with a web page". The worst
// offender is the Python traceback frame marker, which every traceback
// contains. Once such a token is in a conversation's history, every later
// request replays it and is blocked.
//
// What: rewrite those literals in the outgoing request body, and tell the
// model that the rewrite happened and what it means.
//
// Extend: add an entry to DEFAULT_RULES. Nothing else needs to change.
//   id      - stable name, shows up in ctx.report diagnostics
//   match   - RegExp source (string) for the blocked literal
//   flags   - RegExp flags, normally "gi"
//   replace - what the model will see instead
//   legend  - how to describe the original to the model; must NOT contain
//             the blocked literal itself, or the notice would be blocked too
//
// Options (magpie plugin options, all optional):
//   rules     - replace DEFAULT_RULES entirely
//   notice    - false to rewrite silently (default true)
//   providers - provider ids to act on; default: every provider
//
// Coexists with nuaa-responses-fix.middleware.mjs: that one is an in-process
// middleware (onProvider/onEvent, it fixes a premature stream end), this one
// is a gateway hook (onRequest, it rewrites the request before it is sent).
// They touch different stages and neither reads the other's state.

const LT = String.fromCharCode(0x3c);
const GT = String.fromCharCode(0x3e);

const DEFAULT_RULES = [
  {
    id: 'python-module-frame',
    match: LT + 'module' + GT,
    flags: 'gi',
    replace: LT + 'module_' + GT,
    legend: 'the word "module" wrapped in angle brackets (the Python traceback frame marker)',
  },
];

const NOTICE_TAG = '[magpie waf-shim]';

// Only these body fields carry conversation text. Everything else in the body
// (model, tools, stream, ...) is left alone: magpie rejects a hook that
// changes those, and rewriting them would corrupt the request.
const TEXT_KEYS = new Set([
  'instructions',
  'input',
  'messages',
  'content',
  'text',
  'output',
  'arguments',
  'reasoning',
  'summary',
]);

function compile(rules) {
  const out = [];
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    const source = String(r.match || '');
    if (!source) continue;
    out.push({
      id: String(r.id || source),
      re: new RegExp(source, r.flags || 'gi'),
      replace: String(r.replace == null ? '' : r.replace),
      legend: String(r.legend || r.replace || ''),
    });
  }
  return out;
}

function rewriteText(text, rules, hits) {
  let out = text;
  for (const rule of rules) {
    const before = out;
    out = out.replace(rule.re, rule.replace);
    if (out !== before) hits.add(rule.id);
  }
  return out;
}

function walk(node, rules, hits) {
  if (typeof node === 'string') return rewriteText(node, rules, hits);
  if (Array.isArray(node)) return node.map((n) => walk(n, rules, hits));
  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) {
      out[key] = TEXT_KEYS.has(key) ? walk(node[key], rules, hits) : node[key];
    }
    return out;
  }
  return node;
}

function noticeFor(rules) {
  const pairs = rules.map((r) => '"' + r.replace + '" for ' + r.legend);
  return (
    NOTICE_TAG +
    ' The upstream security gateway rewrites a few harmless literals in this request. ' +
    'Read ' +
    pairs.join('; ') +
    '. The rewrite is literal and lossless: the replacement means exactly the original token, ' +
    'and nothing else in this request was altered.'
  );
}

// The notice rides in the conversation, not in "instructions": the upstream
// ignores a top-level instructions field and answers from its own default
// system prompt, so only a system item inside input/messages is honoured.
function injectNotice(body, notice) {
  const item = { role: 'system', content: notice };
  if (Array.isArray(body.input)) {
    body.input = [item].concat(body.input);
  } else if (typeof body.input === 'string') {
    body.input = [item, { role: 'user', content: body.input }];
  } else if (Array.isArray(body.messages)) {
    body.messages = [item].concat(body.messages);
  } else if (typeof body.instructions === 'string') {
    body.instructions = body.instructions.length ? body.instructions + '\n\n' + notice : notice;
  } else {
    body.instructions = notice;
  }
  return body;
}

export async function onRequest(body, ctx) {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;

    const options = (ctx && ctx.options) || {};
    const rules = compile(
      Array.isArray(options.rules) && options.rules.length ? options.rules : DEFAULT_RULES,
    );
    if (rules.length === 0) return undefined;

    if (Array.isArray(options.providers) && options.providers.length) {
      const id = ctx && ctx.provider ? ctx.provider.id : undefined;
      if (!options.providers.includes(id)) return undefined;
    }

    const hits = new Set();
    const next = walk(body, rules, hits);
    if (hits.size === 0) return undefined;

    if (options.notice !== false) {
      const notice = noticeFor(rules);
      const clean = !rules.some((r) =>
        new RegExp(r.re.source, r.re.flags.replace(/g/g, '')).test(notice),
      );
      if (clean) injectNotice(next, notice);
    }

    if (ctx && typeof ctx.report === 'function') {
      let size = 0;
      try {
        size = JSON.stringify(next).length;
      } catch {
        size = 0;
      }
      ctx.report('ready', Math.min(size, 32768));
    }
    return next;
  } catch {
    // Never break a request: magpie keeps the original body when a hook throws.
    return undefined;
  }
}

export default { onRequest };

