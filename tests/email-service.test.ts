import { emailService } from '../src/utils/email.service';

const transport = { sendMail: jest.fn() };
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => transport) }));

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] as const;
const saved: Record<string, string | undefined> = {};
const mail = { to: ['owner@example.com'], subject: 'Report', html: '<p>hi</p>', text: 'hi' };

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of SMTP_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of SMTP_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const configure = () => {
  process.env.SMTP_HOST = 'smtp.test.invalid';
  process.env.SMTP_USER = 'user';
  process.env.SMTP_PASS = 'pass';
};

describe('sendMail result', () => {
  it("is 'not_configured' when SMTP isn't set up", async () => {
    for (const k of SMTP_KEYS) delete process.env[k];
    expect(await emailService.sendMail(mail)).toBe('not_configured');
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  it("is 'sent' when the mail goes out", async () => {
    configure();
    transport.sendMail.mockResolvedValue({});
    expect(await emailService.sendMail(mail)).toBe('sent');
  });

  it("is 'failed' when sending throws", async () => {
    configure();
    transport.sendMail.mockRejectedValue(new Error('connection refused'));
    expect(await emailService.sendMail(mail)).toBe('failed');
  });
});

describe('password reset OTP (unchanged)', () => {
  it('still reports success when SMTP fails or is missing', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    for (const k of SMTP_KEYS) delete process.env[k];
    expect(await emailService.sendPasswordResetOtp({ to: 'a@example.com', otp: '123456' })).toBe(true);
    configure();
    transport.sendMail.mockRejectedValue(new Error('down'));
    expect(await emailService.sendPasswordResetOtp({ to: 'a@example.com', otp: '123456' })).toBe(true);
    log.mockRestore();
  });
});
