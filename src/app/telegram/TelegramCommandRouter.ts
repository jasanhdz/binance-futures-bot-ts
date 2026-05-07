import {
    ParsedTelegramCommand,
    TelegramCommandHandlersPort,
    TelegramCommandName,
    TelegramCommandRouterOptions,
    TelegramInboundMessage
} from './TelegramCommandTypes';

const KNOWN_COMMANDS: TelegramCommandName[] = [
    'help',
    'status',
    'account',
    'positions',
    'config',
    'signal',
    'signals',
    'risk',
    'brackets',
    'report'
];

export class TelegramCommandRouter {
    private readonly lastCommandAtByChat = new Map<string, number>();
    private readonly allowedChatIds: Set<string>;
    private readonly rateLimitMs: number;
    private readonly now: () => number;

    constructor(
        private readonly handlers: TelegramCommandHandlersPort,
        options: TelegramCommandRouterOptions
    ) {
        this.allowedChatIds = new Set(options.allowedChatIds.map(String));
        this.rateLimitMs = options.rateLimitMs ?? 2000;
        this.now = options.now ?? Date.now;
    }

    async handleMessage(message: TelegramInboundMessage): Promise<string | undefined> {
        if (!message.text || !message.text.trim().startsWith('/')) return undefined;

        if (this.allowedChatIds.size === 0) {
            return undefined;
        }

        if (!this.allowedChatIds.has(String(message.chatId))) {
            return 'Unauthorized.';
        }

        const now = this.now();
        const last = this.lastCommandAtByChat.get(String(message.chatId));
        if (last !== undefined && now - last < this.rateLimitMs) {
            return 'Espera un momento antes de enviar otro comando.';
        }
        this.lastCommandAtByChat.set(String(message.chatId), now);

        const command = this.parse(message.text);
        switch (command.name) {
            case 'help':
                return this.handlers.handleHelp();
            case 'status':
                return this.handlers.handleStatus();
            case 'account':
                return this.handlers.handleAccount();
            case 'positions':
                return this.handlers.handlePositions();
            case 'config':
                return this.handlers.handleConfig();
            case 'signal':
                return this.handlers.handleSignal(command.args[0]);
            case 'signals':
                return this.handlers.handleSignals();
            case 'risk':
                return this.handlers.handleRisk();
            case 'brackets':
                return this.handlers.handleBrackets();
            case 'report':
                return command.args[0]?.toLowerCase() === 'today'
                    ? this.handlers.handleReportToday()
                    : this.handlers.handleHelp();
            default:
                return this.handlers.handleHelp();
        }
    }

    parse(text: string): ParsedTelegramCommand {
        const [rawCommand = '', ...args] = text.trim().split(/\s+/);
        const commandToken = rawCommand.replace(/^\/+/, '').split('@')[0].toLowerCase();
        const name = KNOWN_COMMANDS.includes(commandToken as TelegramCommandName)
            ? commandToken as TelegramCommandName
            : 'unknown';
        return { name, args, raw: text };
    }
}
