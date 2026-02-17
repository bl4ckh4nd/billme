import { describe, it, expect } from 'vitest';
import { calculateNextRun } from './recurringService';

describe('recurringService', () => {
  describe('calculateNextRun', () => {
    it('should calculate next daily run', () => {
      const result = calculateNextRun('2026-02-09', 'daily');
      expect(result).toBe('2026-02-10');
    });

    it('should calculate next weekly run', () => {
      const result = calculateNextRun('2026-02-09', 'weekly');
      expect(result).toBe('2026-02-16');
    });

    it('should calculate next monthly run', () => {
      const result = calculateNextRun('2026-02-09', 'monthly');
      expect(result).toBe('2026-03-09');
    });

    it('should calculate next quarterly run', () => {
      const result = calculateNextRun('2026-02-09', 'quarterly');
      expect(result).toBe('2026-05-09');
    });

    it('should calculate next yearly run', () => {
      const result = calculateNextRun('2026-02-09', 'yearly');
      expect(result).toBe('2027-02-09');
    });

    it('should handle month-end dates (Jan 31 → Feb 28)', () => {
      const result = calculateNextRun('2026-01-31', 'monthly');
      expect(result).toBe('2026-02-28');
    });

    it('should handle month-end dates (Jan 31 → Feb 28 in non-leap year)', () => {
      const result = calculateNextRun('2027-01-31', 'monthly');
      expect(result).toBe('2027-02-28');
    });

    it('should handle leap years (Jan 29 → Feb 28 in non-leap year)', () => {
      const result = calculateNextRun('2027-01-29', 'monthly');
      expect(result).toBe('2027-02-28');
    });

    it('should handle leap years (Jan 29 → Feb 29 in leap year)', () => {
      const result = calculateNextRun('2024-01-29', 'monthly');
      expect(result).toBe('2024-02-29');
    });

    it('should handle quarterly month-end dates', () => {
      const result = calculateNextRun('2026-01-31', 'quarterly');
      expect(result).toBe('2026-04-30');
    });

    it('should handle yearly leap year (Feb 29 → Feb 28 next year)', () => {
      const result = calculateNextRun('2024-02-29', 'yearly');
      expect(result).toBe('2025-02-28');
    });

    it('should handle daily progression across month boundary', () => {
      const result = calculateNextRun('2026-02-28', 'daily');
      expect(result).toBe('2026-03-01');
    });

    it('should handle weekly progression across month boundary', () => {
      const result = calculateNextRun('2026-02-25', 'weekly');
      expect(result).toBe('2026-03-04');
    });

    it('should handle monthly progression across year boundary', () => {
      const result = calculateNextRun('2026-12-15', 'monthly');
      expect(result).toBe('2027-01-15');
    });

    it('should handle quarterly progression across year boundary', () => {
      const result = calculateNextRun('2026-11-15', 'quarterly');
      expect(result).toBe('2027-02-15');
    });

    it('should handle edge case: May 31 → June 30 (monthly)', () => {
      const result = calculateNextRun('2026-05-31', 'monthly');
      expect(result).toBe('2026-06-30');
    });

    it('should handle edge case: Aug 31 → Nov 30 (quarterly)', () => {
      const result = calculateNextRun('2026-08-31', 'quarterly');
      expect(result).toBe('2026-11-30');
    });
  });
});
