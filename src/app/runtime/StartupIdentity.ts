import { userInfo, hostname, platform, release } from 'node:os';

export interface StartupIdentity {
  user: string;
  hostname: string;
  platform: string;
  release: string;
}

export function readStartupIdentity(): StartupIdentity {
  const safe = (read: () => string): string => {
    try {
      return (
        read()
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .trim() || 'UNKNOWN'
      );
    } catch {
      return 'UNKNOWN';
    }
  };
  return {
    user: safe(() => userInfo().username),
    hostname: safe(hostname),
    platform: safe(platform),
    release: safe(release),
  };
}
