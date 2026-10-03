// Test-only values; never used outside the local test runtime.
// The client ID and key match taskchampion's own test vector (src/server/generate-test-data.py):
// the key is PBKDF2-HMAC-SHA256('b4a4e6b7b811eda1dc1a2693ded', client ID bytes, 600000 rounds).
export const TEST_CLIENT_ID = '0666d464-418a-4a08-ad53-6f15c78270cd';
export const TEST_SECRET = 'b4a4e6b7b811eda1dc1a2693ded';
export const TEST_SYNC_KEY = 'MWF4PVGahn9cQ7TOia/7bSON47xOO7zmrWBF6dbtZCM='; // gitleaks:allow (taskchampion's public test vector)
export const TEST_API_TOKEN = 'test-token-for-the-local-task-server-only';
export const ORIGIN = 'https://tasks.samewave.dev';
export const TEST_GITHUB_APP_ID = '424242';
export const TEST_GITHUB_WEBHOOK_SECRET = 'test-webhook-secret';
