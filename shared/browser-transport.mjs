import { createBrowserWorkspace } from './browser-workspace.mjs';

// Installed only by the browser build, before the real application mounts.
// Every API operation stays inside this tab; unknown routes never fall through
// to the authenticated AutoDocker server sharing this origin.
export function installBrowserTransport(scope = globalThis, workspace = createBrowserWorkspace()) {
  const previousFetch = scope.fetch;
  const previousEvents = scope.EventSource;
  const previousSocket = scope.WebSocket;
  const previousXHR = scope.XMLHttpRequest;
  const base = scope.location?.href || 'https://autodocker.eu/essai/tracer/';
  const origin = new URL(base).origin;
  const response = (body, status = 200, contentType = 'application/json') =>
    new Response(contentType === 'application/json' ? JSON.stringify(body) : String(body), {
      status,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'no-store' },
    });

  scope.fetch = async (input, init = {}) => {
    if (init.signal?.aborted) throw new DOMException('Demande annulée', 'AbortError');
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, base);
    if (url.origin !== origin || !/^\/api(?:\/|$)/.test(url.pathname)) {
      return response({ error: 'Cette opération n’est pas disponible dans l’atelier navigateur.' }, 403);
    }
    const request = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    const body = init.body ?? (request && request.method !== 'GET' ? await request.clone().text() : undefined);
    if (typeof body === 'string' && new TextEncoder().encode(body).length > 8 * 1024 * 1024) {
      return response({ error: 'Ce projet dépasse la taille acceptée par l’atelier.' }, 413);
    }
    const headers = Object.fromEntries(new Headers(init.headers || request?.headers).entries());
    const result = workspace.handle(url.pathname + url.search, {
      method: init.method || request?.method || 'GET', body, headers,
    });
    return response(result.body, result.status, result.contentType);
  };

  class BrowserEvents extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 2;
    onmessage = null;
    onopen = null;
    onerror = null;
    constructor(url) { super(); this.url = String(url); }
    close() { this.readyState = 2; }
  }
  class BrowserSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 3;
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;
    constructor(url) {
      super(); this.url = String(url);
      queueMicrotask(() => {
        const event = new Event('error');
        this.onerror?.(event);
        this.dispatchEvent(event);
      });
    }
    send() { throw new DOMException('Le terminal demande l’application locale.', 'InvalidStateError'); }
    close() { this.readyState = 3; }
  }
  class BrowserXHR extends EventTarget {
    upload = new EventTarget();
    status = 403;
    readyState = 0;
    responseText = JSON.stringify({ error: 'Les transferts vers Docker demandent l’application locale.' });
    onerror = null;
    onabort = null;
    onloadend = null;
    open() { this.readyState = 1; }
    setRequestHeader() {}
    send() {
      queueMicrotask(() => {
        this.readyState = 4;
        const error = new Event('error');
        this.onerror?.(error); this.dispatchEvent(error);
        const end = new Event('loadend');
        this.onloadend?.(end); this.dispatchEvent(end);
      });
    }
    abort() { const event = new Event('abort'); this.onabort?.(event); this.dispatchEvent(event); }
  }
  scope.EventSource = BrowserEvents;
  scope.WebSocket = BrowserSocket;
  scope.XMLHttpRequest = BrowserXHR;
  return {
    workspace,
    restore() { scope.fetch = previousFetch; scope.EventSource = previousEvents; scope.WebSocket = previousSocket; scope.XMLHttpRequest = previousXHR; },
  };
}
