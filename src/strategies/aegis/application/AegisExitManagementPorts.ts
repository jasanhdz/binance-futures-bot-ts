import type { Side } from '../../../core/types';

export interface AegisExitConfigPort<Config = unknown> {
  getExitEyeConfig(): Config;
  getProfitProtectionConfig(): Config;
}

export interface AegisExitStatePort<State = unknown> {
  read(symbol: string): State;
  write(symbol: string, patch: Partial<State>): void;
}

export interface AegisExitExecutionPort<Position = unknown> {
  readActivePosition(symbol: string, side: Side): Promise<Position | null>;
  listCloseOrdersForSide(symbol: string, side: Side): Promise<unknown[]>;
  moveCloseStop?(params: unknown): Promise<unknown>;
}

export interface AegisExitTelemetryPort {
  log(event: string, payload: Record<string, unknown>): Promise<void>;
}

export interface AegisExitNotificationPort {
  send(message: string): Promise<void>;
  alert(title: string, message: string): Promise<void>;
}
