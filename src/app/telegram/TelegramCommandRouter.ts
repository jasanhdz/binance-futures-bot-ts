import {
  ParsedTelegramCommand,
  TelegramCommandHandlersPort,
  TelegramCommandName,
  TelegramCommandResponse,
  TelegramCommandRouterOptions,
  TelegramInboundMessage,
} from './TelegramCommandTypes';

const KNOWN_COMMANDS: TelegramCommandName[] = [
  'help',
  'status',
  'account',
  'positions',
  'trade',
  'trades',
  'config',
  'signal',
  'signals',
  'risk',
  'riskmode',
  'brackets',
  'report',
  'blocks',
  'momentum',
  'probe',
];

export class TelegramCommandRouter {
  private readonly lastCommandAtByChat = new Map<string, number>();
  private readonly allowedChatIds: Set<string>;
  private readonly allowedUserIds: Set<string>;
  private readonly rateLimitMs: number;
  private readonly now: () => number;
  private readonly mutationsEnabled: boolean;

  constructor(
    private readonly handlers: TelegramCommandHandlersPort,
    options: TelegramCommandRouterOptions,
  ) {
    this.allowedChatIds = new Set(options.allowedChatIds.map(String));
    this.allowedUserIds = new Set((options.allowedUserIds ?? []).map(String));
    this.rateLimitMs = options.rateLimitMs ?? 2000;
    this.now = options.now ?? Date.now;
    this.mutationsEnabled = options.mutationsEnabled === true;
  }

  async handleMessage(
    message: TelegramInboundMessage,
  ): Promise<TelegramCommandResponse | undefined> {
    if (!message.text || !message.text.trim().startsWith('/')) return undefined;

    if (this.allowedChatIds.size === 0) {
      return undefined;
    }

    if (!this.allowedChatIds.has(String(message.chatId))) {
      return 'Unauthorized.';
    }

    const command = this.parse(message.text);
    if (command.name === 'riskmode' && command.args.length > 0) {
      if (!message.fromUserId || !this.allowedUserIds.has(String(message.fromUserId))) {
        return 'Unauthorized.';
      }
      if (!this.mutationsEnabled) return 'Telegram mutations are disabled.';
    }

    const now = this.now();
    const last = this.lastCommandAtByChat.get(String(message.chatId));
    if (last !== undefined && now - last < this.rateLimitMs) {
      return 'Espera un momento antes de enviar otro comando.';
    }
    this.lastCommandAtByChat.set(String(message.chatId), now);

    switch (command.name) {
      case 'help':
        return this.handlers.handleHelp();
      case 'status':
        return this.handlers.handleStatus();
      case 'account':
        return this.handlers.handleAccount();
      case 'positions':
        return this.handlers.handlePositions();
      case 'trade':
        return this.handlers.handleTrade(command.args[0]);
      case 'trades':
        return this.handlers.handleTrades();
      case 'config':
        return this.handlers.handleConfig();
      case 'signal':
        return this.handlers.handleSignal(command.args[0]);
      case 'signals':
        return this.handlers.handleSignals();
      case 'risk':
        return this.handlers.handleRisk();
      case 'riskmode':
        return command.args.length > 0 && message.fromUserId
          ? this.handlers.handleRiskMode(command.args[0], {
              chatId: String(message.chatId),
              userId: String(message.fromUserId),
            })
          : this.handlers.handleRiskMode(command.args[0]);
      case 'brackets':
        return this.handlers.handleBrackets();
      case 'report':
        return command.args[0]?.toLowerCase() === 'today'
          ? this.handlers.handleReportToday()
          : this.handlers.handleHelp();
      case 'blocks':
        return this.handlers.handleBlocks(command.args);
      case 'momentum':
        return this.handlers.handleMomentum(command.args);
      case 'probe':
        return this.handlers.handleProbe(command.args);
      default:
        return this.handlers.handleHelp();
    }
  }

  parse(text: string): ParsedTelegramCommand {
    const [rawCommand = '', ...args] = text.trim().split(/\s+/);
    const commandToken = rawCommand.replace(/^\/+/, '').split('@')[0].toLowerCase();
    const name = KNOWN_COMMANDS.includes(commandToken as TelegramCommandName)
      ? (commandToken as TelegramCommandName)
      : 'unknown';
    return { name, args, raw: text };
  }
}
