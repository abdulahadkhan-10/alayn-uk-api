/*
 * Pre-screen for AlaynAI: turns away requests for software work (writing code, debugging...) before
 * they reach the model. It must not block café questions that merely contain a "techy" word —
 * a loyalty program, a discount code, a Java Chip Frappe, a private function, ruby chocolate.
 * Anything else that's off-topic is left to the model's own instructions.
 */

// Programming languages that are not also food or everyday words
const LANGUAGE = /(?:^|[^\w])(python|javascript|typescript|c\+\+|c#|golang|php|kotlin|html|css|sql|bash|powershell|node\.?js)(?=$|[^\w#+])/;

// Java, Ruby, Rust, Swift, React only count when they're clearly about software
const AMBIGUOUS_LANGUAGE = /\b(java|ruby|rust|swift|react)\s+(code|program|programs|programming|script|class|function|app|developer)\b/;

// Words that only make sense for software work
const SOFTWARE_WORK = /\b(source code|coding|programming|debug|debugging|compile|compiler|refactor|syntax|regex|stack ?trace)\b/;

// "write/give me/show me ... code", but not a discount code, QR code, HSN code...
const WRITE_CODE =
  /\b(write|give me|show me|send me|generate|fix)\b[^.?!\n]{0,30}(?<!\b(?:discount|promo|coupon|voucher|qr|referral|offer|hsn|sac|gst|dress|pin|zip|bar|tax)\s)\bcode\b/;

// Pasted code
const CODE_TEXT = [/```/, /\bdef\s+\w+\s*\(/, /\bfunction\s+\w+\s*\(/, /\bconsole\.log\(/, /\bimport\s+[\w{},*\s]+\s+from\s+['"]/, /#include\s*</];

export function isCodingRequest(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return (
    LANGUAGE.test(p) ||
    AMBIGUOUS_LANGUAGE.test(p) ||
    SOFTWARE_WORK.test(p) ||
    WRITE_CODE.test(p) ||
    CODE_TEXT.some((pattern) => pattern.test(prompt))
  );
}
