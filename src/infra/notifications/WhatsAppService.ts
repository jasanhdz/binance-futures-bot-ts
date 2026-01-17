

export class WhatsAppService {
    private static get API_KEY(): string {
        return process.env.WHATSAPP_API_KEY || "";
    }

    private static get PHONE(): string {
        return process.env.WHATSAPP_PHONE || "";
    }

    static async sendAlert(message: string) {
        if (!this.API_KEY || !this.PHONE) {
            console.warn("⚠️ WhatsApp Alert skipped: Missing WHATSAPP_API_KEY or WHATSAPP_PHONE in .env");
            return;
        }

        // Añadimos un timestamp para evitar que WhatsApp agrupe mensajes y los ignore
        const timestamp = new Date().toLocaleTimeString();
        const finalMsg = `[${timestamp}] ${message}`;

        const url = `https://api.callmebot.com/whatsapp.php?phone=${this.PHONE}&text=${encodeURIComponent(finalMsg)}&apikey=${this.API_KEY}`;

        try {
            const response = await fetch(url);
            if (response.ok) {
                console.log("✅ Alerta Berzerker enviada a WhatsApp");
            } else {
                console.warn(`⚠️ WhatsApp API returned status: ${response.status}`);
            }
        } catch (error) {
            console.error("❌ Error en WhatsApp Gateway:", error);
        }
    }
}
