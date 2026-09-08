export interface ProductProfile {
  appId: string;
  appName: string;
  productName: string;
  dbFileName: string;
  dataDirName: string;
  backupPrefix: string;
  localTenantId: string;
  localUserId: string;
  localUserEmail: string;
  localUserFullName: string;
}

export const PRODUCT_PROFILE: ProductProfile = {
  appId: 'com.billme.pro',
  appName: 'Billme Pro',
  productName: 'Billme Pro',
  dbFileName: 'billme-pro-v2.sqlite',
  dataDirName: 'billme-pro-pglite',
  backupPrefix: 'billme-pro-v2',
  localTenantId: 'billme-pro-local-tenant',
  localUserId: 'billme-pro-local-user',
  localUserEmail: 'local-pro@billme.app',
  localUserFullName: 'Lokaler Billme Pro Benutzer',
};
