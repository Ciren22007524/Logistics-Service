import { describe, expect, it } from 'vitest';
import { MockAdapter } from '../../src/carriers/mock/mock.adapter.js';
import {
  createShipmentSchema,
  extractZip,
  hasCity,
  normalizeLandline,
  normalizeMobile,
  sanitizeItems,
  validateForCarrier,
} from '../../src/domain/shipment/validation.js';

const mock = new MockAdapter('http://localhost:4310');
const base = {
  external_ref: 'ORD-1',
  service_type: 'HOME_DELIVERY' as const,
  recipient: { name: '王小明', phone: '0912-345-678', address: '330桃園市桃園區某某路1號' },
  items_summary: '服飾一批',
};

describe('validation', () => {
  it('normalizes mobile numbers', () => {
    expect(normalizeMobile('0912-345-678')).toBe('0912345678');
    expect(normalizeMobile('+886912345678')).toBe('0912345678');
    expect(normalizeMobile('0812345678')).toBeNull();
    expect(normalizeMobile('091234567')).toBeNull();
  });

  it('accepts landlines with area code', () => {
    expect(normalizeLandline('02-2345-6789')).toBe('0223456789');
    expect(normalizeLandline('03-3123456#12')).toBe('033123456#12');
    expect(normalizeLandline('2345678')).toBeNull();
  });

  it('address must contain city; zip extracted', () => {
    expect(hasCity('桃園市桃園區某某路1號')).toBe(true);
    expect(hasCity('某某路1號')).toBe(false);
    expect(extractZip('33044 桃園市桃園區')).toEqual({ zip: '33044', rest: '桃園市桃園區' });
  });

  it('items are sanitized and truncated', () => {
    expect(sanitizeItems('衣服<b>&"好看"\n', 30)).toBe('衣服b好看');
    expect([...sanitizeItems('一'.repeat(100), 30)].length).toBe(30);
  });

  it('home delivery passes and is normalized', () => {
    const req = createShipmentSchema.parse(base);
    const { errors, normalized } = validateForCarrier(req, mock);
    expect(errors).toEqual({});
    expect(normalized.recipient.phone).toBe('0912345678');
    expect(normalized.recipient.zip).toBe('330');
    expect(normalized.recipient.address).toBe('桃園市桃園區某某路1號');
  });

  it('cvs requires store and matching carrier', () => {
    const req = createShipmentSchema.parse({ ...base, service_type: 'CVS_PICKUP', recipient: { name: '王小明', phone: '0912345678' } });
    expect(validateForCarrier(req, mock).errors.cvs_store).toBeTruthy();
    const req2 = createShipmentSchema.parse({
      ...req,
      cvs_store: { sub_type: 'UNIMARTC2C', store_id: '131386', carrier_code: 'ECPAY_CVS' },
    });
    const e = validateForCarrier(req2, mock).errors;
    expect(e['cvs_store.carrier_code']).toBeTruthy();
    expect(e['cvs_store.sub_type']).toBeTruthy();
  });

  it('rejects bad phone and cod over limit', () => {
    const req = createShipmentSchema.parse({ ...base, recipient: { ...base.recipient, phone: '12345678' }, cod_amount: 99999 });
    const e = validateForCarrier(req, mock).errors;
    expect(e['recipient.phone']).toBeTruthy();
    expect(e.cod_amount).toBeTruthy();
  });

  it('schema rejects unknown fields', () => {
    expect(createShipmentSchema.safeParse({ ...base, hacker: 1 }).success).toBe(false);
  });
});
