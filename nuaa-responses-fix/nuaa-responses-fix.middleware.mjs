// Magpie in-process middleware. No network, credentials, subprocess or listener.
export function onProvider(body, ctx) {
  ctx.state.active = ctx.protocol === 'responses' && ctx.provider.id === 'nuaa'
    && ctx.provider.model === 'deepseek-flash';
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
