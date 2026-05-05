import axios from 'axios';

export interface CryptoPanicPost {
    kind: 'news' | 'media';
    domain: string;
    source: {
        title: string;
        region: string;
        domain: string;
        path: string | null;
    };
    title: string;
    published_at: string;
    slug: string;
    id: number;
    url: string;
    created_at: string;
    votes: {
        negative: number;
        positive: number;
        important: number;
        liked: number;
        disliked: number;
        lol: number;
        toxic: number;
        saved: number;
        comments: number;
    };
}

export interface CryptoPanicResponse {
    count: number;
    next: string | null;
    previous: string | null;
    results: CryptoPanicPost[];
}

export class CryptoPanicAdapter {
    private apiKey: string;
    private baseUrl: string = 'https://cryptopanic.com/api/developer/v2';

    constructor() {
        this.apiKey = process.env.CRYPTOPANIC_API_KEY || '';
        if (!this.apiKey) {
            console.warn('⚠️ [CryptoPanicAdapter] CRYPTOPANIC_API_KEY is missing in .env. Live news fetching will fail.');
        }
    }

    /**
     * Fetches the latest global crypto news or specific filtered news
     * @param filter Filter by type: 'rising', 'hot', 'bullish', 'bearish', 'important'
     */
    async getLatestNews(filter?: string): Promise<CryptoPanicPost[]> {
        if (!this.apiKey) return [];

        try {
            const url = `${this.baseUrl}/posts/`;
            const params: any = { auth_token: this.apiKey, public: true };
            if (filter) {
                params.filter = filter;
            }

            const response = await axios.get<CryptoPanicResponse>(url, { params });
            return response.data.results || [];
        } catch (error: any) {
            console.error(`[CryptoPanicAdapter] Error fetching news: ${error.message}`);
            return [];
        }
    }
}
