
import { MlProbabilityServiceClient } from './src/infra/adapters/PhantomMLAdapter';

async function main() {
    console.log('🔍 Verifying TypeScript API Client...');

    // 1. Instantiate Client (defaults to http://127.0.0.1:8001)
    const client = new MlProbabilityServiceClient({
        baseUrl: 'http://127.0.0.1:8001',
        timeoutMs: 5000
    });

    // 2. Check Health
    console.log('🏥 Checking Health...');
    const isHealthy = await client.checkHealth();
    if (isHealthy) {
        console.log('✅ API is Healthy');
    } else {
        console.error('❌ API is Unhealthy or Unreachable');
        process.exit(1);
    }

    // 3. Fetch Probabilities for BTCUSDT
    try {
        console.log('🔮 Fetching Probabilities for BTCUSDT...');
        const result = await client.fetchProbabilities({ symbol: 'BTCUSDT' });

        console.log('✅ Result Received:');
        console.log(JSON.stringify(result, null, 2));

        if (result.meta_verdict === 'PHANTOM_V30') {
            console.log('✅ Verified: Response is from Phantom V30');
        } else {
            console.warn(`⚠️ Warning: Meta Verdict is ${result.meta_verdict}`);
        }

    } catch (error) {
        console.error('❌ Failed to fetch probabilities:', error);
        process.exit(1);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
