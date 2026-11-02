// Recognises the pages and responses on which collection must stop at once and hand over to the owner:
// checkpoints, CAPTCHAs, login walls, "temporarily blocked" and rate-limit warnings (English and Vietnamese UI).

export type BlockCode = 'checkpoint' | 'captcha' | 'login_required' | 'temporarily_blocked' | 'rate_limited' | 'account_locked';

export interface BlockSignal {
  code: BlockCode;
  evidence: string;
}

const URL_RULES: [RegExp, BlockCode][] = [
  [/\/checkpoint(\/|\?|$)/i, 'checkpoint'],
  [/\/two_step_verification|\/two_factor/i, 'checkpoint'],
  [/captcha|\/recaptcha\//i, 'captcha'],
  [/\/login(\.php)?(\/|\?|$)|\/accounts\/login/i, 'login_required'],
  [/\/challenge(\/|\?|$)/i, 'checkpoint'],
];

const TEXT_RULES: [RegExp, BlockCode][] = [
  [/you['’]re temporarily blocked|you have been temporarily blocked|bạn tạm thời bị chặn/i, 'temporarily_blocked'],
  [/it looks like you were misusing this feature|có vẻ như bạn đã sử dụng sai tính năng này/i, 'temporarily_blocked'],
  [/we limit how often you can post|chúng tôi giới hạn tần suất/i, 'rate_limited'],
  [/please wait a few minutes before you try again|vui lòng đợi vài phút rồi thử lại/i, 'rate_limited'],
  [/we suspect automated behavior|we('ve| have) detected (unusual|suspicious) activity|chúng tôi nghi ngờ (có )?hành vi tự động|phát hiện hoạt động bất thường/i, 'checkpoint'],
  [/your account has been (locked|suspended|disabled)|tài khoản của bạn (đã )?bị (khóa|tạm ngừng|vô hiệu hóa)/i, 'account_locked'],
  [/confirm (that )?(it['’]s you|your identity)|xác nhận (danh tính|đó là bạn)/i, 'checkpoint'],
  [/security check|kiểm tra bảo mật|enter the characters you see|nhập các ký tự bạn thấy/i, 'captcha'],
  [/log in to continue|you must log in|đăng nhập để tiếp tục|bạn phải đăng nhập/i, 'login_required'],
];

// Facebook GraphQL / Instagram API error codes that mean "stop".
const API_CODES: Record<number, BlockCode> = {
  1357001: 'login_required', // not logged in
  1357004: 'login_required',
  1675004: 'rate_limited', // "You're temporarily blocked" / rate limit
  1390008: 'rate_limited', // "You can't use this feature at the moment"
  368: 'temporarily_blocked', // policy block
};

/**
 * Pure check of a page's URL and text. Pass the text of dialogs/alerts and the page title, plus the body text
 * only when the expected content (feed, post) is missing, so that words inside ordinary posts never stop a crawl.
 */
export function detectBlockInPage(url: string, visibleText: string): BlockSignal | null {
  for (const [re, code] of URL_RULES) if (re.test(url)) return { code, evidence: `url ${new URL(url).pathname}` };
  const text = visibleText.slice(0, 20_000);
  for (const [re, code] of TEXT_RULES) {
    const m = re.exec(text);
    if (m) return { code, evidence: `text "${m[0].slice(0, 80)}"` };
  }
  return null;
}

/** Pure check of an HTTP response the page received. */
export function detectBlockInResponse(status: number, body: unknown): BlockSignal | null {
  if (status === 429) return { code: 'rate_limited', evidence: 'HTTP 429' };
  const errors = collectErrors(body);
  for (const e of errors) {
    const code = API_CODES[e.code];
    if (code) return { code, evidence: `api error ${e.code}` };
    if (/checkpoint/i.test(e.message)) return { code: 'checkpoint', evidence: 'api checkpoint' };
  }
  return null;
}

function collectErrors(body: unknown): { code: number; message: string }[] {
  const out: { code: number; message: string }[] = [];
  const visit = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.error === 'number') out.push({ code: o.error, message: String(o.errorSummary ?? o.errorDescription ?? '') });
    if (Array.isArray(o.errors)) {
      for (const e of o.errors as Record<string, unknown>[]) {
        const code = Number(e?.code ?? e?.api_error_code);
        if (Number.isFinite(code)) out.push({ code, message: String(e?.message ?? e?.summary ?? '') });
      }
    }
    if (o.message === 'checkpoint_required' || o.checkpoint_url) out.push({ code: -1, message: 'checkpoint' });
  };
  visit(body);
  return out;
}
