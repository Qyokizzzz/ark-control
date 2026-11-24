import { ARKSHOP_UI_WORKSHOP_ID } from '@ark-control/common';

export const workshopCatalog = [
  { id: ARKSHOP_UI_WORKSHOP_ID, name: 'MX-E Ark Shop UI', category: '商店界面' },
  { id: '731604991', name: 'Structures Plus (S+)', category: '建筑优化' },
  { id: '1999447172', name: 'Super Structures', category: '建筑优化' },
  { id: '1609138312', name: 'Dino Storage v2', category: '恐龙收纳' },
  { id: '1404697612', name: 'Awesome SpyGlass!', category: '生物信息' },
  { id: '889745138', name: 'Awesome Teleporters!', category: '传送' },
  { id: '1428596566', name: 'Auto Engrams!', category: '印痕解锁' },
  { id: '1522327484', name: 'ARK Additions: The Collection!', category: '新增生物' },
  { id: '751991809', name: 'Death Recovery Mod', category: '遗失物找回' },
];

export const workshopById = new Map(workshopCatalog.map((mod) => [mod.id, mod]));
