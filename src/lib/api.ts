// Resilient JSON API fetch helper that handles cold starts, server restarts,
// expired preview cookies, and nested JSON error messages gracefully.

function extractReadableError(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: string | { message?: string };
        message?: string;
      };
      if (typeof parsed.error === 'string') return extractReadableError(parsed.error, fallback);
      if (parsed.error && typeof parsed.error === 'object' && parsed.error.message) {
        return parsed.error.message;
      }
      if (typeof parsed.message === 'string') return parsed.message;
    } catch {
      // use raw string below
    }
  }
  return trimmed;
}

function isHtmlPayload(trimmed: string, contentType: string | null): boolean {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  return (
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<HTML')
  );
}

export interface ApiJsonResult<T> {
  ok: boolean;
  status: number;
  data: T;
  error?: string;
  needsReload?: boolean;
}

export async function apiJson<T = Record<string, unknown>>(
  url: string,
  options?: RequestInit
): Promise<ApiJsonResult<T>> {
  const attempt = async (): Promise<Response> => {
    const headers = new Headers(options?.headers);
    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }
    return fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  };

  const retryDelaysMs = [800, 1600, 2400];
  let res: Response | null = null;
  let rawText = '';
  let trimmed = '';
  let lastWasAuthRedirect = false;

  for (let i = 0; i <= retryDelaysMs.length; i++) {
    try {
      res = await attempt();
      rawText = await res.text();
      trimmed = rawText.trim();
    } catch {
      if (i < retryDelaysMs.length) {
        await new Promise((r) => window.setTimeout(r, retryDelaysMs[i]));
        continue;
      }
      return {
        ok: false,
        status: 503,
        data: {} as T,
        error: 'Could not reach the server. Please check your connection or refresh the page.',
        needsReload: true,
      };
    }

    const html = isHtmlPayload(trimmed, res.headers.get('content-type'));
    if (!html) {
      break;
    }

    const redirectedUrl = (res.url || '').toLowerCase();
    lastWasAuthRedirect =
      redirectedUrl.includes('__cookie_check') ||
      redirectedUrl.includes('accounts.google') ||
      trimmed.includes('__cookie_check');

    // If the preview auth cookie expired, retrying won't mint a new browser cookie; prompt 1-click refresh
    if (lastWasAuthRedirect && i >= 1) {
      break;
    }

    if (i < retryDelaysMs.length) {
      // Send a lightweight GET ping to wake up a cold-starting container before retrying POST
      try {
        await fetch('/api/twilio/health', { credentials: 'same-origin', cache: 'no-store' });
      } catch {
        // ignore wakeup ping error
      }
      await new Promise((r) => window.setTimeout(r, retryDelaysMs[i]));
    }
  }

  if (!res || isHtmlPayload(trimmed, res.headers.get('content-type'))) {
    return {
      ok: false,
      status: res?.status || 503,
      data: {} as T,
      needsReload: true,
      error: lastWasAuthRedirect
        ? 'Your preview session expired after being idle. Click "Refresh Session" to reconnect and place your call.'
        : 'The server was waking up or restarting and returned an HTML page instead of JSON. Click "Refresh Session" and try again.',
    };
  }

  let parsed: Record<string, unknown> = {};
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        status: res.status || 500,
        data: {} as T,
        error: `Unexpected server response (${res.status}). Please try again.`,
      };
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      data: parsed as T,
      error: extractReadableError(parsed.error ?? parsed.message, `Request failed (${res.status}).`),
    };
  }

  return {
    ok: true,
    status: res.status,
    data: parsed as T,
  };
}
