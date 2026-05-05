/**
 * Notifier Port - Application Layer Interface
 */

export interface Notifier {
    sendMessage(message: string): Promise<void>;
    sendAlert(title: string, body: string): Promise<void>;
}
