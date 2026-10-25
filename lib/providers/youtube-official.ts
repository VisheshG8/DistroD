import { fetchLegacy } from './legacy';
import type { SocialDataProvider } from './types';
export const youtubeOfficial: SocialDataProvider = {
  id: 'youtube-official', platforms: ['youtube'], fetchPage: (page, context) => fetchLegacy('youtube-official', page, context),
};
