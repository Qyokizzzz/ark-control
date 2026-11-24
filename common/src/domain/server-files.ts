import type { Instance, ServerFiles } from '@common/types';

export const usesServerFiles = (instance: Instance, file: ServerFiles) =>
  instance.hostId === file.hostId &&
  (instance.serverFileId === file.id ||
    file.instanceIds?.includes(instance.id) === true ||
    file.instanceId === instance.id);

export const reservesServerFiles = (instance: Instance, file: ServerFiles) =>
  instance.hostId === file.hostId &&
  !instance.installed &&
  !instance.serverFileId &&
  instance.serverFileSource === file.id;

export const shareableServerFiles = (file: ServerFiles) =>
  !!file.instanceIds && ['ready', 'in-use'].includes(file.status);
