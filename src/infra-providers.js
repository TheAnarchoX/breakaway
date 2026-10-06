/**
 * The Worker's providers: the real ones, registered in the registry the store reads (`infraRegistry()`), so the core
 * in infra-provider.js never names a vendor. A new provider is one line here.
 */
import { providers } from './infra-provider.js';
import { cloudflare } from './infra-cloudflare.js';

providers.register(cloudflare);

export { providers };
