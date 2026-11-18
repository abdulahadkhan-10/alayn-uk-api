import { SubscriptionService, gbpToInrRate, poundsToChargeAmount } from '../src/modules/subscription/subscription.service';
import { SubscriptionRepository } from '../src/modules/subscription/subscription.repository';
import { CashfreeService } from '../src/modules/subscription/cashfree.service';

jest.mock('../src/modules/subscription/subscription.repository');
jest.mock('../src/modules/subscription/cashfree.service');
jest.mock('../src/config/prisma', () => ({ prisma: {} }));

const repo = SubscriptionRepository.prototype as jest.Mocked<SubscriptionRepository>;
const cashfree = CashfreeService.prototype as jest.Mocked<CashfreeService>;

describe('Cashfree charges in rupees', () => {
  const OLD_RATE = process.env.CASHFREE_GBP_TO_INR_RATE;
  afterEach(() => {
    process.env.CASHFREE_GBP_TO_INR_RATE = OLD_RATE;
  });

  it('converts pounds to rupees with the configured rate, to the paisa', () => {
    expect(poundsToChargeAmount(79, 110.5)).toBe(8729.5);
    expect(poundsToChargeAmount(600, 112.37)).toBe(67422);
    expect(poundsToChargeAmount(0.01, 112.37)).toBe(1.12);
  });

  it('refuses to charge when no rate is configured, instead of guessing one', () => {
    delete process.env.CASHFREE_GBP_TO_INR_RATE;
    expect(() => gbpToInrRate()).toThrow('Card payments are not set up yet');
    process.env.CASHFREE_GBP_TO_INR_RATE = 'abc';
    expect(() => gbpToInrRate()).toThrow('Card payments are not set up yet');
    process.env.CASHFREE_GBP_TO_INR_RATE = '110.5';
    expect(gbpToInrRate()).toBe(110.5);
  });
});

describe('verifying a subscription payment', () => {
  const service = new SubscriptionService();
  const payment = (overrides: any = {}) => ({
    cfOrderId: 'ALAYN_SUB_1',
    paymentStatus: 'PENDING',
    amountPence: 7900,
    currency: 'GBP',
    chargedAmount: 8729.5,
    chargedCurrency: 'INR',
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    cashfree.getOrderPayments.mockResolvedValue([{ payment_status: 'SUCCESS', cf_payment_id: 1 }] as any);
    repo.markPaymentSuccess.mockResolvedValue({ subscription: { status: 'ACTIVE' }, payment: {} } as any);
  });

  it('activates when Cashfree collected the full rupee amount', async () => {
    repo.getPaymentByOrderId.mockResolvedValue(payment() as any);
    cashfree.getOrder.mockResolvedValue({ order_status: 'PAID', order_amount: 8729.5, order_currency: 'INR' } as any);
    await expect(service.verifyOutletPayment('ALAYN_SUB_1')).resolves.toMatchObject({ status: 'PAID' });
  });

  it('rejects a rupee order for less than was asked', async () => {
    repo.getPaymentByOrderId.mockResolvedValue(payment() as any);
    cashfree.getOrder.mockResolvedValue({ order_status: 'PAID', order_amount: 79, order_currency: 'INR' } as any);
    await expect(service.verifyOutletPayment('ALAYN_SUB_1')).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
    expect(repo.markPaymentSuccess).not.toHaveBeenCalled();
  });

  it('rejects an order in a different currency, even with a bigger number', async () => {
    repo.getPaymentByOrderId.mockResolvedValue(payment() as any);
    cashfree.getOrder.mockResolvedValue({ order_status: 'PAID', order_amount: 9000, order_currency: 'GBP' } as any);
    await expect(service.verifyOutletPayment('ALAYN_SUB_1')).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
  });

  it('still checks older pound payments against the pound amount', async () => {
    repo.getPaymentByOrderId.mockResolvedValue(payment({ chargedAmount: null, chargedCurrency: null }) as any);
    cashfree.getOrder.mockResolvedValue({ order_status: 'PAID', order_amount: 79, order_currency: 'GBP' } as any);
    await expect(service.verifyOutletPayment('ALAYN_SUB_1')).resolves.toMatchObject({ status: 'PAID' });
  });
});
