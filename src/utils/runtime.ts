export type AppEnv = 'testnet' | 'prod';

export const APP_ENV: AppEnv = (process.env.APP_ENV as AppEnv) || 'testnet';

export const IS_TESTNET = APP_ENV === 'testnet';
