import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AppSettings } from '@billme/desktop-core/types';
import { ipc } from '../runtime-api';

const settingsKey = ['settings'] as const;

export const useSettingsQuery = () => {
  return useQuery({
    queryKey: settingsKey,
    queryFn: () => ipc.settings.get(),
  });
};

export const useSetSettingsMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (settings: AppSettings) => ipc.settings.set({ settings }),
    onSuccess: (_res, settings) => {
      queryClient.setQueryData(settingsKey, settings);
    },
  });
};
