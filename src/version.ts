import packageJson from '../package.json';

declare const __BUILD_COMMIT__: string | undefined;

export const VERSION = packageJson.version;
export const COMMIT =
  typeof __BUILD_COMMIT__ === 'string' && __BUILD_COMMIT__.length > 0 ? __BUILD_COMMIT__ : 'unknown';
