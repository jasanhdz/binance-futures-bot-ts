export interface Logger {
  debug(msg: string, ctx?: any): void;
  info(msg: string, ctx?: any): void;
  warn(msg: string, ctx?: any): void;
  error(msg: string, ctx?: any): void;
}
