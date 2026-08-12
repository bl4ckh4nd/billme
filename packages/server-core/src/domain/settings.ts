import { z } from 'zod';

export const businessReportingProfileSchema = z
  .object({
    jurisdiction: z.literal('DE'),
    legalForm: z.enum(['sole_proprietor', 'gmbh']),
    profitDetermination: z.enum(['eur', 'double_entry']),
    hgbSizeClass: z.enum(['micro', 'small']).optional(),
    fiscalYearStart: z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Expected MM-DD'),
    chart: z.enum(['SKR03', 'SKR04']).optional(),
    vatMethod: z.enum(['soll', 'ist']),
  })
  .superRefine((profile, ctx) => {
    if (profile.profitDetermination === 'eur' && profile.fiscalYearStart !== '01-01') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fiscalYearStart'],
        message: 'EÜR requires a calendar-year start (01-01)',
      });
    }
    if (profile.legalForm !== 'gmbh') return;
    if (profile.profitDetermination !== 'double_entry') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profitDetermination'],
        message: 'GmbH requires double-entry accounting',
      });
    }
    if (!profile.hgbSizeClass) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hgbSizeClass'],
        message: 'GmbH requires an HGB size class',
      });
    }
    if (!profile.chart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chart'],
        message: 'GmbH requires a ledger chart',
      });
    }
  });

export type BusinessReportingProfile = z.infer<typeof businessReportingProfileSchema>;
