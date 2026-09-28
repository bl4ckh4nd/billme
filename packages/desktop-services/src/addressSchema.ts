import { z } from 'zod';

export const AddressSchema = z.object({
  street: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  company: z.string().optional(),
  contactPerson: z.string().optional(),
});
