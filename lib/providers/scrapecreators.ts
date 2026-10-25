import { fetchLegacy } from './legacy';
import type { SocialDataProvider } from './types';
export const scrapecreators: SocialDataProvider = {
  id: 'scrapecreators', platforms: ['instagram', 'tiktok', 'youtube'], fetchPage: (page, context) => fetchLegacy('scrapecreators', page, context),
};
