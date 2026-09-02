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
  appId: 'com.billme.desktop',
  appName: 'Billme',
  productName: 'Billme',
  dbFileName: 'billme.sqlite',
  dataDirName: 'billme-pglite',
  backupPrefix: 'billme',
  localTenantId: 'billme-local-tenant',
  localUserId: 'billme-local-user',
  localUserEmail: 'local@billme.app',
  localUserFullName: 'Lokaler Billme Benutzer',
};
