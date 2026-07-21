import { v4 as uuidv4 } from 'uuid';

/** Stable unique id for designer elements/rows. */
export const generateId = (): string => uuidv4();
