import type { Invoice } from '@billme/desktop-core/types';
import { createUiStore, type BaseUiState } from '@billme/desktop-state/uiStore';

export type UiState = BaseUiState<Invoice>;
export const useUiStore = createUiStore<Invoice>();
