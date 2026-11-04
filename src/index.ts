import type { API } from 'homebridge';
import { OpenEvsePlatform, PLATFORM_NAME } from './platform';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, OpenEvsePlatform);
};
