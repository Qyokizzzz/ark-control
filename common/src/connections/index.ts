// Unmodified upstream runtime; validate the complete archive before executing it.
export const CONNECT_CORE_VERSION = '2.6.4';
export const CONNECT_RUNTIME = {
  windows: {
    file: 'easytier-windows-x86_64-v2.6.4.zip',
    sha256: '27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84',
    executable: 'easytier-core.exe',
  },
} as const;
// Select a working community node at deployment; old public endpoints may expire.
export const CONNECT_DEFAULT_PEERS: string[] = [];
export const CONNECT_CONTROLLER_IP = '10.126.126.1';
export const CONNECT_GAME_IP = '10.126.126.2';
export const CONNECT_FOOTER = 'ARKCONNECT-V1-END';
