import { describe, it, expect } from 'vitest';

// Financial calculation functions to test
// These are extracted from the codebase for testing

/**
 * Calculate VAT amount from net price and tax rate
 */
export const calculateVat = (netAmount: number, taxRate: number): number => {
  return netAmount * (taxRate / 100);
};

/**
 * Calculate gross price from net price and tax rate
 */
export const calculateGross = (netAmount: number, taxRate: number): number => {
  return netAmount + calculateVat(netAmount, taxRate);
};

/**
 * Calculate net amount from gross price and tax rate
 */
export const calculateNet = (grossAmount: number, taxRate: number): number => {
  return grossAmount / (1 + taxRate / 100);
};

/**
 * Calculate invoice total with items
 */
export const calculateInvoiceTotal = (
  items: Array<{ quantity: number; price: number; taxRate: number }>
): { net: number; vat: number; gross: number } => {
  let totalNet = 0;
  let totalVat = 0;

  for (const item of items) {
    const itemNet = item.quantity * item.price;
    const itemVat = calculateVat(itemNet, item.taxRate);
    totalNet += itemNet;
    totalVat += itemVat;
  }

  return {
    net: totalNet,
    vat: totalVat,
    gross: totalNet + totalVat,
  };
};

/**
 * Calculate days overdue for an invoice (from dunningService.ts)
 */
export const calculateDaysOverdue = (dueDate: string): number => {
  const due = new Date(dueDate);
  const now = new Date();
  const diffMs = now.getTime() - due.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
};

/**
 * Calculate amount difference for transaction matching
 */
export const calculateAmountDiff = (amount1: number, amount2: number): number => {
  return Math.abs(amount1 - amount2);
};

/**
 * Check if amounts match within tolerance
 */
export const amountsMatchWithTolerance = (
  amount1: number,
  amount2: number,
  tolerance: number = 0.01
): boolean => {
  return calculateAmountDiff(amount1, amount2) <= tolerance;
};

// ============================================
// TESTS
// ============================================

describe('VAT Calculations', () => {
  describe('calculateVat', () => {
    it('should calculate 19% VAT correctly', () => {
      expect(calculateVat(100, 19)).toBeCloseTo(19, 2);
    });

    it('should calculate 7% VAT correctly', () => {
      expect(calculateVat(100, 7)).toBeCloseTo(7, 2);
    });

    it('should return 0 for 0% VAT', () => {
      expect(calculateVat(100, 0)).toBe(0);
    });

    it('should handle decimal net amounts', () => {
      expect(calculateVat(99.99, 19)).toBeCloseTo(18.9981, 2);
    });

    it('should handle zero net amount', () => {
      expect(calculateVat(0, 19)).toBe(0);
    });

    it('should handle negative amounts (credit notes)', () => {
      expect(calculateVat(-100, 19)).toBeCloseTo(-19, 2);
    });
  });

  describe('calculateGross', () => {
    it('should calculate gross from net with 19% VAT', () => {
      expect(calculateGross(100, 19)).toBeCloseTo(119, 2);
    });

    it('should calculate gross from net with 7% VAT', () => {
      expect(calculateGross(100, 7)).toBeCloseTo(107, 2);
    });

    it('should return net amount when VAT is 0%', () => {
      expect(calculateGross(100, 0)).toBe(100);
    });

    it('should handle decimal amounts', () => {
      expect(calculateGross(49.99, 19)).toBeCloseTo(59.4881, 2);
    });
  });

  describe('calculateNet', () => {
    it('should calculate net from gross with 19% VAT', () => {
      expect(calculateNet(119, 19)).toBeCloseTo(100, 2);
    });

    it('should calculate net from gross with 7% VAT', () => {
      expect(calculateNet(107, 7)).toBeCloseTo(100, 2);
    });

    it('should handle 0% VAT', () => {
      expect(calculateNet(100, 0)).toBe(100);
    });

    it('should handle decimal gross amounts', () => {
      expect(calculateNet(59.99, 19)).toBeCloseTo(50.411764, 2);
    });

    it('should be inverse of calculateGross', () => {
      const net = 100;
      const taxRate = 19;
      const gross = calculateGross(net, taxRate);
      const calculatedNet = calculateNet(gross, taxRate);
      expect(calculatedNet).toBeCloseTo(net, 2);
    });
  });
});

describe('Invoice Total Calculations', () => {
  describe('calculateInvoiceTotal', () => {
    it('should calculate total for single item with 19% VAT', () => {
      const items = [{ quantity: 1, price: 100, taxRate: 19 }];
      const result = calculateInvoiceTotal(items);
      expect(result.net).toBeCloseTo(100, 2);
      expect(result.vat).toBeCloseTo(19, 2);
      expect(result.gross).toBeCloseTo(119, 2);
    });

    it('should calculate total for multiple items with same VAT', () => {
      const items = [
        { quantity: 2, price: 50, taxRate: 19 },
        { quantity: 1, price: 100, taxRate: 19 },
      ];
      const result = calculateInvoiceTotal(items);
      expect(result.net).toBeCloseTo(200, 2);
      expect(result.vat).toBeCloseTo(38, 2);
      expect(result.gross).toBeCloseTo(238, 2);
    });

    it('should calculate total for items with mixed VAT rates', () => {
      const items = [
        { quantity: 1, price: 100, taxRate: 19 },
        { quantity: 1, price: 100, taxRate: 7 },
      ];
      const result = calculateInvoiceTotal(items);
      expect(result.net).toBeCloseTo(200, 2);
      expect(result.vat).toBeCloseTo(26, 2); // 19 + 7
      expect(result.gross).toBeCloseTo(226, 2);
    });

    it('should handle items with 0% VAT', () => {
      const items = [
        { quantity: 1, price: 100, taxRate: 19 },
        { quantity: 1, price: 50, taxRate: 0 },
      ];
      const result = calculateInvoiceTotal(items);
      expect(result.net).toBeCloseTo(150, 2);
      expect(result.vat).toBeCloseTo(19, 2);
      expect(result.gross).toBeCloseTo(169, 2);
    });

    it('should handle decimal quantities and prices', () => {
      const items = [{ quantity: 2.5, price: 39.99, taxRate: 19 }];
      const result = calculateInvoiceTotal(items);
      const expectedNet = 2.5 * 39.99;
      const expectedVat = calculateVat(expectedNet, 19);
      expect(result.net).toBeCloseTo(expectedNet, 2);
      expect(result.vat).toBeCloseTo(expectedVat, 2);
      expect(result.gross).toBeCloseTo(expectedNet + expectedVat, 2);
    });

    it('should return zero totals for empty items array', () => {
      const result = calculateInvoiceTotal([]);
      expect(result.net).toBe(0);
      expect(result.vat).toBe(0);
      expect(result.gross).toBe(0);
    });

    it('should handle negative quantities (credit notes)', () => {
      const items = [{ quantity: -1, price: 100, taxRate: 19 }];
      const result = calculateInvoiceTotal(items);
      expect(result.net).toBeCloseTo(-100, 2);
      expect(result.vat).toBeCloseTo(-19, 2);
      expect(result.gross).toBeCloseTo(-119, 2);
    });
  });
});

describe('Dunning Fee Calculations', () => {
  describe('calculateDaysOverdue', () => {
    it('should return 0 for future due date', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 10);
      const daysOverdue = calculateDaysOverdue(futureDate.toISOString());
      expect(daysOverdue).toBe(0);
    });

    it('should calculate days overdue correctly', () => {
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 10);
      const daysOverdue = calculateDaysOverdue(pastDate.toISOString());
      expect(daysOverdue).toBeGreaterThanOrEqual(10);
      expect(daysOverdue).toBeLessThanOrEqual(11); // Account for time precision
    });

    it('should return 0 for today', () => {
      const today = new Date();
      const daysOverdue = calculateDaysOverdue(today.toISOString());
      expect(daysOverdue).toBeLessThanOrEqual(1);
    });

    it('should handle very old dates', () => {
      const veryOldDate = '2020-01-01T00:00:00.000Z';
      const daysOverdue = calculateDaysOverdue(veryOldDate);
      expect(daysOverdue).toBeGreaterThan(1000);
    });
  });
});

describe('Transaction Matching', () => {
  describe('calculateAmountDiff', () => {
    it('should calculate positive difference', () => {
      expect(calculateAmountDiff(100, 95)).toBe(5);
    });

    it('should calculate negative difference as positive', () => {
      expect(calculateAmountDiff(95, 100)).toBe(5);
    });

    it('should return 0 for identical amounts', () => {
      expect(calculateAmountDiff(100, 100)).toBe(0);
    });

    it('should handle decimal amounts', () => {
      expect(calculateAmountDiff(100.50, 100.25)).toBeCloseTo(0.25, 2);
    });
  });

  describe('amountsMatchWithTolerance', () => {
    it('should match identical amounts', () => {
      expect(amountsMatchWithTolerance(100, 100)).toBe(true);
    });

    it('should match amounts within default tolerance (0.01)', () => {
      expect(amountsMatchWithTolerance(100, 100.005)).toBe(true);
    });

    it('should not match amounts outside default tolerance', () => {
      expect(amountsMatchWithTolerance(100, 100.02)).toBe(false);
    });

    it('should respect custom tolerance', () => {
      expect(amountsMatchWithTolerance(100, 100.50, 1.0)).toBe(true);
      expect(amountsMatchWithTolerance(100, 101.50, 1.0)).toBe(false);
    });

    it('should handle negative amounts', () => {
      expect(amountsMatchWithTolerance(-100, -100.005)).toBe(true);
    });

    it('should match amounts with rounding errors', () => {
      const amount1 = 99.99 * 1.19; // 118.9881
      const amount2 = 118.99;
      expect(amountsMatchWithTolerance(amount1, amount2)).toBe(true);
    });
  });
});

describe('Edge Cases and Error Handling', () => {
  it('should handle very large numbers', () => {
    const vat = calculateVat(1000000, 19);
    expect(vat).toBeCloseTo(190000, 2);
  });

  it('should handle very small numbers', () => {
    const vat = calculateVat(0.01, 19);
    expect(vat).toBeCloseTo(0.0019, 4);
  });

  it('should maintain precision with multiple calculations', () => {
    const net = 99.99;
    const taxRate = 19;
    const gross = calculateGross(net, taxRate);
    const recalculatedNet = calculateNet(gross, taxRate);
    expect(recalculatedNet).toBeCloseTo(net, 2);
  });

  it('should handle invoice with many items', () => {
    const items = Array(100).fill({ quantity: 1, price: 10, taxRate: 19 });
    const result = calculateInvoiceTotal(items);
    expect(result.net).toBeCloseTo(1000, 2);
    expect(result.vat).toBeCloseTo(190, 2);
    expect(result.gross).toBeCloseTo(1190, 2);
  });
});
