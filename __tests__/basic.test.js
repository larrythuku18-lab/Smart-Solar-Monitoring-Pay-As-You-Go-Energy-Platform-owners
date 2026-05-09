import { jest } from '@jest/globals';

describe('Basic Test Suite', () => {
  test('should run a simple test', () => {
    expect(1 + 1).toBe(2);
  });

  test('should validate token format', () => {
    const tokenRegex = /^[A-Z0-9]{8}$/;
    expect(tokenRegex.test('ABCDEFGH')).toBe(true);
    expect(tokenRegex.test('12345678')).toBe(true);
    expect(tokenRegex.test('ABC123')).toBe(false);
    expect(tokenRegex.test('abcdefgh')).toBe(false);
  });

  test('should calculate kWh from KES', () => {
    // Assuming 20 KES per kWh
    const ratePerKwh = 20;
    const calculateKwhValue = (amountKes) => Math.floor(amountKes / ratePerKwh);

    expect(calculateKwhValue(200)).toBe(10);
    expect(calculateKwhValue(500)).toBe(25);
    expect(calculateKwhValue(1000)).toBe(50);
  });
});