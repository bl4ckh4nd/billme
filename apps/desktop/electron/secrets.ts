import keytar from 'keytar';

const SERVICE = 'billme';

export type SecretKey =
  | 'smtp.password'
  | 'portal.apiKey'
  | 'resend.apiKey';

export const secrets = {
  get: async (key: SecretKey): Promise<string | null> => {
    return keytar.getPassword(SERVICE, key);
  },
  set: async (key: SecretKey, value: string): Promise<void> => {
    await keytar.setPassword(SERVICE, key, value);
  },
  delete: async (key: SecretKey): Promise<boolean> => {
    return keytar.deletePassword(SERVICE, key);
  },
};

