import { CryptoPanicAdapter, CryptoPanicPost } from './CryptoPanicAdapter';
export interface SentinelStatus {
    isPanic: boolean;
    panicScore: number;
    topPanicHeadline: string | null;
    lastUpdated: number;
}

export class SentinelService {
    private adapter: CryptoPanicAdapter;

    private currentStatus: SentinelStatus = {
        isPanic: false,
        panicScore: 0,
        topPanicHeadline: null,
        lastUpdated: 0
    };

    // Panic threshold to veto longs
    private readonly PANIC_THRESHOLD = -15;

    // Refresh interval: 5 minutes
    private readonly REFRESH_INTERVAL_MS = 5 * 60 * 1000;

    // Weighted Keywords for Heuristic NLP (Case Insensitive)
    private readonly KEYWORD_WEIGHTS: Record<string, number> = {
        // Severe Panic (-10)
        'war': -10,
        'guerra': -10,
        'hack': -10,
        'stolen': -10,
        'ban': -10,
        'sec sues': -10,
        'arrested': -10,
        'investigation': -10,
        'doj': -10,
        'fbi': -10,
        'collapse': -10,
        'bankrupt': -10,
        'bankruptcy': -10,

        // Moderate Panic (-5)
        'liquidation': -5,
        'crash': -5,
        'drop': -5,
        'cpi': -5,
        'rate hike': -5,
        'fear': -5,
        'plunge': -5,
        'dump': -5,
        'selloff': -5,
        'blood': -5,

        // Euphoria (Positive weights to counteract noise)
        'adoption': 5,
        'approved': 5,
        'bull': 5,
        'ath': 5,
        'pump': 5,
        'partnership': 5
    };

    constructor() {
        this.adapter = new CryptoPanicAdapter();
    }

    /**
     * Updates the macro status by fetching latest news and scoring it.
     */
    async updateStatus(): Promise<void> {
        try {
            const news = await this.adapter.getLatestNews('important'); // Primary filter
            const risingNews = await this.adapter.getLatestNews('rising'); // Secondary filter

            // Combine and deduplicate
            const uniqueNewsMap = new Map<number, CryptoPanicPost>();
            [...news, ...risingNews].forEach(post => uniqueNewsMap.set(post.id, post));
            const allNews = Array.from(uniqueNewsMap.values());

            if (allNews.length === 0) {
                // If API fails or no token, stay safe (don't block)
                return;
            }

            let totalScore = 0;
            let worstHeadline: string | null = null;
            let lowestPostScore = 0;

            for (const post of allNews) {
                const titleLower = post.title.toLowerCase();
                let postScore = 0;

                for (const [keyword, weight] of Object.entries(this.KEYWORD_WEIGHTS)) {
                    // Match whole words to avoid false positives (e.g. 'ban' in 'bank')
                    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
                    if (regex.test(titleLower)) {
                        postScore += weight;
                    }
                }

                // Add community sentiment
                if (post.votes.negative > post.votes.positive && post.votes.negative > 10) {
                    postScore -= 5;
                }

                totalScore += postScore;

                if (postScore < lowestPostScore) {
                    lowestPostScore = postScore;
                    worstHeadline = post.title;
                }
            }

            const isPanic = totalScore <= this.PANIC_THRESHOLD;

            if (isPanic && !this.currentStatus.isPanic) {
                console.warn(`🔴 MACRO PANIC DETECTED! Total Score: ${totalScore}. Worst Headline: "${worstHeadline}"`);
            } else if (!isPanic && this.currentStatus.isPanic) {
                console.info(`🟢 MACRO PANIC LIFTED. Total Score: ${totalScore}. The storm has passed.`);
            }

            this.currentStatus = {
                isPanic,
                panicScore: totalScore,
                topPanicHeadline: worstHeadline,
                lastUpdated: Date.now()
            };

        } catch (error: any) {
            console.error(`Failed to update Sentinel status: ${error.message}`);
        }
    }

    /**
     * Gets the current Sentinel macro status, fetching automatically if expired.
     */
    async getMacroStatus(): Promise<SentinelStatus> {
        const now = Date.now();
        if (now - this.currentStatus.lastUpdated > this.REFRESH_INTERVAL_MS) {
            await this.updateStatus();
        }
        return this.currentStatus;
    }
}
