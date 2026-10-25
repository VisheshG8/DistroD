import { fetchLegacy } from './legacy';
import type { SocialDataProvider } from './types';
export const tikhub: SocialDataProvider = {
  id: 'tikhub', platforms: ['instagram', 'tiktok', 'youtube'], fetchPage: (page, context) => fetchLegacy('tikhub', page, context),
};
