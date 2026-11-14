// What every target gives the scenario: `send(method, path, { body, headers })` → { status, type, headers, text, bytes }.
export const toResult = async (res) => {
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type") ?? "", headers: Object.fromEntries(res.headers), text: new TextDecoder().decode(bytes), bytes };
};

export const toRequest = (base, method, path, { body, headers } = {}) =>
  new Request(new URL(path, base), { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body });

/**
 * `send` over HTTP below `base`.  `headers` go with every request (the target's own, below the scenario's); `scope` may change the
 * URL of each request (a Durable Object room); `timeoutMs` bounds one request.
 */
export const viaFetch = (base, { headers: fixed = {}, scope, timeoutMs } = {}) => async (method, path, init = {}) => {
  const url = new URL(path, base);
  scope?.(url);
  const request = toRequest(url, method, "", { ...init, headers: { ...fixed, ...init.headers } });
  return toResult(await fetch(request, timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : undefined));
};
