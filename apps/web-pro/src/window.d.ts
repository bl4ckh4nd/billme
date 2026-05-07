type BillmeRuntimeConfig = {
  serverApiUrl?: string;
};

declare global {
  interface Window {
    billmeRuntimeConfig?: BillmeRuntimeConfig;
  }
}

export {};
