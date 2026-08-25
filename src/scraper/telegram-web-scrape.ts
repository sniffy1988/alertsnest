import http from 'http';
import https from 'https';
import axios from 'axios';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const axiosInstance = axios.create({
  timeout: 2800,
  headers: { 'User-Agent': USER_AGENT },
  httpAgent: new http.Agent({ keepAlive: true }),
  httpsAgent: new https.Agent({ keepAlive: true }),
});

export const TELEGRAM_WEB_HOSTS = ['t.me', 'telegram.me'] as const;
export type TelegramWebHost = (typeof TELEGRAM_WEB_HOSTS)[number];

let preferredHost: TelegramWebHost | null = null;

export function channelPreviewUrl(host: TelegramWebHost, username: string): string {
  return `https://${host}/s/${username}`;
}

function hostsInOrder(): TelegramWebHost[] {
  if (!preferredHost) return [...TELEGRAM_WEB_HOSTS];
  return [preferredHost, ...TELEGRAM_WEB_HOSTS.filter((h) => h !== preferredHost)];
}

export function isHttp429(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { response?: { status?: number } }).response?.status === 429);
}

function isRetryable(err: unknown): boolean {
  const e = err as { response?: { status?: number }; code?: string };
  const status = e?.response?.status;
  if (status === 429) return true;
  if (status != null && status >= 500 && status < 600) return true;
  if (e?.code === 'ECONNRESET' || e?.code === 'ETIMEDOUT' || e?.code === 'ECONNABORTED') return true;
  return err instanceof Error && err.message.includes('timeout');
}

async function fetchWithRetry(url: string, maxAttempts = 2): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axiosInstance.get(url);
      return response.data as string;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && isRetryable(err) && !isHttp429(err)) {
        await new Promise((r) => setTimeout(r, 150 * attempt));
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

export async function fetchChannelHtml(username: string): Promise<string> {
  let lastError: unknown;
  for (const host of hostsInOrder()) {
    try {
      const html = await fetchWithRetry(channelPreviewUrl(host, username));
      preferredHost = host;
      return html;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
