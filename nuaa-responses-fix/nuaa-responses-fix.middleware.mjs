// Magpie in-process middleware. No network, credentials, subprocess or listener.
//
// Scope: every provider and every model, as long as the request speaks the
// Responses protocol. The bug this fixes is a protocol artifact - an upstream
// closing a stream in a way that makes magpie append "no terminal event" after a
// perfectly good response.completed - so it is not tied to one vendor or model.
export function onProvider(body, ctx) {
  ctx.state.active = ctx.protocol === 'responses';
  ctx.state.completed = false;
  ctx.state.failed = false;
}

export function onEvent(event, ctx) {
  if (!ctx.state.active) return;
  const r = event.response;
  if (event.type === 'response.completed' && r && r.status === 'completed'
      && typeof r.id === 'string' && r.id.length > 0 && Array.isArray(r.output)
      && !ctx.state.failed) {
    ctx.state.completed = true;
    return;
  }
  if (ctx.state.completed && event.type === 'error' && event.error
      && event.error.code === 'responses.incomplete_stream'
      && event.error.message === 'Upstream stream ended without a terminal Responses event') {
    return null;
  }
  if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
    ctx.state.failed = true;
  }
}
