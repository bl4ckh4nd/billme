import { createBillmeApi } from './api';
import { createMockInvoke } from './mockEngine';

export const mockBackendApi = createBillmeApi(createMockInvoke());
