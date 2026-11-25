import { gameConfigSchema, iniAddress } from '@ark-control/common';
import type { IniFile } from '@ark-control/common';

export type IniKind = 'number' | 'integer' | 'text' | 'password' | 'switch' | 'list';
export interface IniOption {
  file: IniFile;
  section: string;
  key: string;
  label: string;
  defaultValue: number | boolean | string | null;
  kind: IniKind;
  hint?: string;
}

type Row = [
  key: string,
  label: string,
  defaultValue: IniOption['defaultValue'],
  kind: IniKind,
  hint?: string,
];

function section(file: IniFile, name: string, rows: Row[]): IniOption[] {
  return rows.map(([key, label, defaultValue, kind, hint]) => ({
    file,
    section: name,
    key,
    label,
    defaultValue,
    kind,
    hint,
  }));
}

export const optionId = (option: Pick<IniOption, 'file' | 'section' | 'key'>) =>
  option.file + ':' + iniAddress(option.section, option.key);

// ASE keys and default values from https://ark.wiki.gg/wiki/Server_configuration.
// The pinned values come first. Map-dependent or undocumented defaults remain unset.
export const advancedGroups = [
  {
    title: '常用高级',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['LimitTurretsNum', '炮塔数量上限', 100, 'integer', '同一统计范围内允许的炮塔数量。'],
        [
          'DinoTurretDamageMultiplier',
          '炮塔对恐龙伤害倍率',
          1,
          'number',
          '倍率越大，自动炮塔对生物的伤害越高。',
        ],
        [
          'BabyMatureSpeedMultiplier',
          '恐龙成长速度倍率',
          gameConfigSchema.shape.babyMature.parse(undefined),
          'number',
          '10 倍时，幼崽成长耗时约为原来的十分之一。',
        ],
        ['BabyImprintingStatScaleMultiplier', '留痕属性加成倍率', 1, 'number'],
        [
          'BabyImprintAmountMultiplier',
          '单次留痕进度倍率',
          1,
          'number',
          '数值越高，每次照料增加的留痕进度越多。',
        ],
        [
          'BabyCuddleIntervalMultiplier',
          '留痕间隔倍率',
          1,
          'number',
          '1 倍约为 8 小时。缩短间隔可以增加成年前的照料次数。',
        ],
        ['bLimitTurretsInRange', '启用区域炮塔限制', true, 'switch'],
        ['LimitTurretsRange', '炮塔统计半径', 10000, 'number', '100 游戏距离单位约为 1 米。'],
        [
          'bHardLimitTurretsInRange',
          '限制已放置的炮塔',
          false,
          'switch',
          '对已放置且超限的炮塔也执行硬限制。',
        ],
      ]),
    ],
  },
  {
    title: '繁殖与驯养',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['BabyCuddleGracePeriodMultiplier', '留痕宽限期倍率', 1, 'number'],
        ['BabyCuddleLoseImprintQualitySpeedMultiplier', '留痕流失速度倍率', 1, 'number'],
        ['BabyFoodConsumptionSpeedMultiplier', '幼崽食物消耗倍率', 1, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['AllowAnyoneBabyImprintCuddle', '允许其他玩家协助留痕', false, 'switch'],
        ['DisableImprintDinoBuff', '关闭骑乘者留痕加成', false, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bDisableDinoBreeding', '禁止繁殖', false, 'switch'],
        ['bDisableDinoRiding', '禁止骑乘', false, 'switch'],
        ['bDisableDinoTaming', '禁止驯服', false, 'switch'],
        ['PreventBreedingForClassNames', '禁止繁殖的生物', null, 'list'],
        ['PreventDinoTameClassNames', '禁止驯服的生物', null, 'list'],
        ['bAllowUnclaimDinos', '允许放生', true, 'switch'],
        ['LayEggIntervalMultiplier', '产蛋间隔倍率', 1, 'number'],
        ['MatingSpeedMultiplier', '交配速度倍率', 1, 'number'],
        ['PassiveTameIntervalMultiplier', '和平驯服喂食间隔倍率', 1, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['AllowRaidDinoFeeding', '允许喂食泰坦龙等攻城生物', false, 'switch'],
        ['RaidDinoCharacterFoodDrainMultiplier', '攻城生物食物消耗倍率', 1, 'number'],
        ['PreventMateBoost', '关闭伴侣加成', false, 'switch'],
        ['MaxTamedDinos', '地图驯养数量上限', 5000, 'number'],
        ['MaxPersonalTamedDinos', '单个部落或玩家的驯养上限', 0, 'integer'],
        ['PersonalTamedDinosSaddleStructureCost', '平台鞍占用的驯养名额', 0, 'integer'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bUseTameLimitForStructuresOnly', '仅平台建筑占用驯养额度', false, 'switch'],
        ['DestroyTamesOverLevelClamp', '启动时删除超过此等级的驯养生物', 0, 'integer'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['FreezeReaperPregnancy', '冻结死神妊娠计时', false, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['TamedDinoCharacterFoodDrainMultiplier', '已驯生物食物消耗倍率', 1, 'number'],
        ['WildDinoCharacterFoodDrainMultiplier', '野生生物食物消耗倍率', 1, 'number'],
        ['TamedDinoTorporDrainMultiplier', '已驯生物眩晕消退倍率', 1, 'number'],
        ['WildDinoTorporDrainMultiplier', '野生生物眩晕消退倍率', 1, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['DinoCharacterFoodDrainMultiplier', '生物食物消耗倍率', 1, 'number'],
        ['DinoCharacterHealthRecoveryMultiplier', '生物生命恢复倍率', 1, 'number'],
        ['DinoCharacterStaminaDrainMultiplier', '生物耐力消耗倍率', 1, 'number'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bUseDinoLevelUpAnimations', '播放生物升级动画', true, 'switch'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['AllowFlyingStaminaRecovery', '允许站在飞行生物上恢复耐力', false, 'switch'],
        ['AllowFlyerCarryPvE', 'PvE 允许飞行生物抓取', false, 'switch'],
        ['bForceCanRideFliers', '强制允许骑乘飞行生物', null, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bAllowFlyerSpeedLeveling', '允许飞行生物升级移动速度', false, 'switch'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['UseFjordurTraversalBuff', '启用峡湾跨领域效果', false, 'switch'],
      ]),
    ],
  },
  {
    title: '建筑与衰减',
    options: [
      ...section('settings', 'ServerSettings', [
        ['AlwaysAllowStructurePickup', '随时拾取建筑', false, 'switch'],
        ['StructurePickupTimeAfterPlacement', '放置后可拾取时长（秒）', 30, 'number'],
        ['StructurePickupHoldDuration', '拾取按住时长（秒）', 0.5, 'number'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bDisableStructurePlacementCollision', '放宽建筑碰撞限制', false, 'switch'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['TheMaxStructuresInRange', '区域建筑数量上限', 10500, 'integer'],
        ['EnableExtraStructurePreventionVolumes', '启用额外禁建区', false, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bIgnoreStructuresPreventionVolumes', '忽略地图禁建区', false, 'switch'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['AllowCaveBuildingPvE', '允许 PvE 洞穴建造', false, 'switch'],
        ['AllowCaveBuildingPvP', '允许 PvP 洞穴建造', true, 'switch'],
        ['PvEAllowStructuresAtSupplyDrops', '允许 PvE 在补给点建造', false, 'switch'],
        ['AllowIntegratedSPlusStructures', '启用内置 S+ 建筑', true, 'switch'],
        ['PerPlatformMaxStructuresMultiplier', '平台鞍建筑数量倍率', 1, 'number'],
        ['MaxPlatformSaddleStructureLimit', '地图平台鞍和筏子数量上限', 75, 'integer'],
        ['MaxGateFrameOnSaddles', '平台鞍门框数量上限', 0, 'integer'],
        ['PlatformSaddleBuildAreaBoundsMultiplier', '平台鞍建筑范围倍率', 1, 'number'],
        ['OverrideStructurePlatformPrevention', '解除平台鞍建筑类型限制', false, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bAllowPlatformSaddleMultiFloors', '允许平台鞍建多层建筑', false, 'switch'],
        ['bFlyerPlatformAllowUnalignedDinoBasing', '飞行平台允许非盟友生物站立', false, 'switch'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['ForceAllStructureLocking', '强制建筑锁定', false, 'switch'],
        ['DestroyUnconnectedWaterPipes', '自动销毁孤立水管', false, 'switch'],
        ['DisableStructureDecayPvE', '关闭 PvE 建筑衰减', false, 'switch'],
        ['PvEStructureDecayPeriodMultiplier', 'PvE 建筑衰减周期倍率', 1, 'number'],
        ['PvPStructureDecay', '启用 PvP 建筑衰减', false, 'switch'],
        ['AutoDestroyOldStructuresMultiplier', '废弃建筑自动销毁时间倍率', 0, 'number'],
        ['OnlyAutoDestroyCoreStructures', '仅自动销毁核心建筑', false, 'switch'],
        ['OnlyDecayUnsnappedCoreStructures', '仅衰减未吸附核心建筑', false, 'switch'],
        ['FastDecayUnsnappedCoreStructures', '未吸附核心建筑快速衰减', false, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['FastDecayInterval', '快速衰减时间（秒）', 43200, 'integer'],
        ['StructureDamageRepairCooldown', '建筑受伤后修理冷却（秒）', 180, 'integer'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['StructurePreventResourceRadiusMultiplier', '建筑阻止资源刷新的半径倍率', 1, 'number'],
        ['StructureResistanceMultiplier', '建筑抗性倍率', 1, 'number'],
        ['StructureDamageMultiplier', '建筑伤害倍率', 1, 'number'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['PvPZoneStructureDamageMultiplier', 'PvP 区域建筑伤害倍率', 6, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['MaxStructuresInSmallRadius', '小半径建筑数量上限', 0, 'integer'],
        ['RadiusStructuresInSmallRadius', '小半径统计范围', 0, 'number'],
        ['MaxStructuresToProcess', '建筑处理数量上限', 0, 'integer'],
        ['IgnoreLimitMaxStructuresInRangeTypeFlag', '统计受限建筑时忽略类型标记', false, 'switch'],
        ['DisableDinoDecayPvE', '关闭 PvE 生物衰减', false, 'switch'],
        ['PvEDinoDecayPeriodMultiplier', 'PvE 生物衰减周期倍率', 1, 'number'],
        ['PvPDinoDecay', '启用 PvP 生物衰减', false, 'switch'],
        ['AutoDestroyDecayedDinos', '自动销毁已衰减的驯养生物', false, 'switch'],
      ]),
    ],
  },
  {
    title: '玩家、战斗与部落',
    options: [
      ...section('settings', 'ServerSettings', [
        ['PlayerCharacterFoodDrainMultiplier', '玩家饥饿消耗倍率', 1, 'number'],
        ['PlayerCharacterWaterDrainMultiplier', '玩家口渴消耗倍率', 1, 'number'],
        ['PlayerCharacterStaminaDrainMultiplier', '玩家耐力消耗倍率', 1, 'number'],
        ['PlayerCharacterHealthRecoveryMultiplier', '玩家生命恢复倍率', 1, 'number'],
        ['PlayerDamageMultiplier', '玩家伤害倍率', 1, 'number'],
        ['PlayerResistanceMultiplier', '玩家抗性倍率', 1, 'number'],
        ['DinoDamageMultiplier', '野生生物伤害倍率', 1, 'number'],
        ['DinoResistanceMultiplier', '野生生物抗性倍率', 1, 'number'],
        ['TamedDinoDamageMultiplier', '驯养生物伤害倍率', 1, 'number'],
        ['TamedDinoResistanceMultiplier', '驯养生物抗性倍率', 1, 'number'],
        ['OxygenSwimSpeedStatMultiplier', '氧气属性对游速的倍率', 1, 'number'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['MaxFallSpeedMultiplier', '最大坠落速度倍率', 1, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['ServerHardcore', '硬核模式', false, 'switch'],
        ['ShowFloatingDamageText', '显示飘字伤害', false, 'switch'],
        ['AllowHitMarkers', '显示命中标记', true, 'switch'],
        ['ServerCrosshair', '显示准星', true, 'switch'],
        ['ServerForceNoHUD', '强制隐藏 HUD', false, 'switch'],
        ['ShowMapPlayerLocation', '显示玩家在地图上的位置', true, 'switch'],
        ['AllowThirdPersonPlayer', '允许第三人称', true, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bUseCorpseLocator', '启用尸体定位光柱', true, 'switch'],
        ['bShowCreativeMode', '显示创造模式', false, 'switch'],
        ['bAllowUnlimitedRespecs', '允许连续使用洗点药', false, 'switch'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['PreventDiseases', '关闭疾病', false, 'switch'],
        ['NonPermanentDiseases', '疾病不永久保留', false, 'switch'],
        ['PreventSpawnAnimations', '跳过出生动画', false, 'switch'],
        ['PreventOfflinePvP', '启用离线保护', false, 'switch'],
        ['PreventOfflinePvPInterval', '离线保护延迟（秒）', 0, 'number'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        [
          'PreventOfflinePvPConnectionInvincibleInterval',
          '连接时离线保护无敌时长（秒）',
          5,
          'number',
        ],
        ['bDisableFriendlyFire', '关闭友军伤害', false, 'switch'],
        ['bPvEDisableFriendlyFire', '关闭 PvE 友军伤害', false, 'switch'],
        ['bPassiveDefensesDamageRiderlessDinos', '拒马可伤害无人骑乘的生物', false, 'switch'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['AllowMultipleAttachedC4', '允许在单只生物上放多个 C4', false, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bIncreasePvPRespawnInterval', '启用 PvP 复活惩罚', true, 'switch'],
        ['IncreasePvPRespawnIntervalBaseAmount', 'PvP 复活基础等待（秒）', 60, 'number'],
        ['IncreasePvPRespawnIntervalCheckPeriod', 'PvP 复活惩罚检查周期（秒）', 300, 'number'],
        ['IncreasePvPRespawnIntervalMultiplier', 'PvP 复活等待倍率', 2, 'number'],
        ['bPvEAllowTribeWar', '允许 PvE 部落宣战', true, 'switch'],
        ['bPvEAllowTribeWarCancel', '允许取消 PvE 部落战争', false, 'switch'],
        ['bAutoPvETimer', '启用定时切换 PvE', false, 'switch'],
        ['bAutoPvEUseSystemTime', '定时 PvE 使用系统时钟', false, 'switch'],
        ['AutoPvEStartTimeSeconds', '定时 PvE 开始时间（秒）', 0, 'number'],
        ['AutoPvEStopTimeSeconds', '定时 PvE 结束时间（秒）', 0, 'number'],
        ['MaxNumberOfPlayersInTribe', '部落人数上限', 0, 'integer'],
        ['MaxAlliancesPerTribe', '每个部落的联盟上限', null, 'integer', '留空时交由游戏决定。'],
        ['MaxTribesPerAlliance', '每个联盟的部落上限', null, 'integer', '留空时交由游戏决定。'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['TribeNameChangeCooldown', '部落改名冷却（分钟）', 15, 'number'],
        ['PreventTribeAlliances', '禁止部落联盟', false, 'switch'],
        ['TribeMergeAllowed', '允许部落合并', true, 'switch'],
        ['TribeMergeCooldown', '部落合并冷却', 0, 'number'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['TribeSlotReuseCooldown', '部落成员名额复用冷却', 0, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['PreventOutOfTribePinCodeUse', '禁止部落外玩家使用 PIN', false, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['MaxTribeLogs', '部落日志保留条数', 400, 'integer'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['TribeLogDestroyedEnemyStructures', '记录敌方建筑被摧毁', false, 'switch'],
        ['AllowHideDamageSourceFromLogs', '允许部落日志隐藏伤害来源', true, 'switch'],
        ['EnablePvPGamma', '允许 PvP 使用 Gamma 命令', false, 'switch'],
        ['DisablePvEGamma', '禁止 PvE 使用 Gamma 命令', false, 'switch'],
        ['EnableCryoSicknessPVE', '启用 PvE 冷冻病', false, 'switch'],
        ['EnableCryopodNerf', '启用低温舱限制', false, 'switch'],
        ['CryopodNerfDuration', '低温舱限制时长（秒）', 0, 'integer'],
        ['CryopodNerfDamageMult', '低温舱虚弱期间输出伤害倍率', 0.0099999998, 'number'],
        ['CryopodNerfIncomingDamageMultPercent', '低温舱虚弱期间受到额外伤害比例', 0, 'number'],
      ]),
    ],
  },
  {
    title: '经验、采集与世界',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['KillXPMultiplier', '击杀经验倍率', 1, 'number'],
        ['HarvestXPMultiplier', '采集经验倍率', 1, 'number'],
        ['CraftXPMultiplier', '制作经验倍率', 1, 'number'],
        ['GenericXPMultiplier', '被动经验倍率', 1, 'number'],
        ['SpecialXPMultiplier', '特殊事件经验倍率', 1, 'number'],
        ['DinoHarvestingDamageMultiplier', '生物采集伤害倍率', 3.2, 'number'],
        ['PlayerHarvestingDamageMultiplier', '玩家采集伤害倍率', 1, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['HarvestHealthMultiplier', '可采集资源耐久倍率', 1, 'number'],
        ['ClampResourceHarvestDamage', '限制单次采集伤害', false, 'switch'],
        ['UseOptimizedHarvestingHealth', '启用优化的采集计算', false, 'switch'],
        ['ResourcesRespawnPeriodMultiplier', '资源刷新间隔倍率', 1, 'number'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['ResourceNoReplenishRadiusPlayers', '玩家阻止资源刷新的半径倍率', 1, 'number'],
        ['ResourceNoReplenishRadiusStructures', '建筑阻止资源刷新的半径倍率', 1, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['DayCycleSpeedScale', '昼夜循环速度倍率', 1, 'number'],
        ['DayTimeSpeedScale', '白天时间流速倍率', 1, 'number'],
        ['NightTimeSpeedScale', '夜晚时间流速倍率', 1, 'number'],
        ['DifficultyOffset', '基础难度系数', 1, 'number'],
        ['DisableWeatherFog', '关闭天气雾', false, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['BaseTemperatureMultiplier', '地图温度倍率', 1, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['DinoCountMultiplier', '野生生物数量倍率', 1, 'number'],
        ['ServerAutoForceRespawnWildDinosInterval', '定期重刷野生生物间隔（秒）', 0, 'number'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['HairGrowthSpeedMultiplier', '头发生长速度倍率', 1, 'number'],
        ['PoopIntervalMultiplier', '排泄间隔倍率', 1, 'number'],
        ['bUseSingleplayerSettings', '应用单人玩法倍率', false, 'switch'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['ExtinctionEventTimeInterval', '灭绝模式周期（秒）', null, 'number'],
      ]),
    ],
  },
  {
    title: '物品、掉落与制作',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bAllowCustomRecipes', '允许自制配方', true, 'switch'],
        ['CustomRecipeEffectivenessMultiplier', '自制配方效果倍率', 1, 'number'],
        ['CustomRecipeSkillMultiplier', '自制配方技能倍率', 1, 'number'],
        ['CraftingSkillBonusMultiplier', '制作技能加成倍率', 1, 'number'],
        ['bDisableLootCrates', '禁止补给箱刷新', false, 'switch'],
        ['SupplyCrateLootQualityMultiplier', '补给箱战利品品质倍率', 1, 'number'],
        ['FishingLootQualityMultiplier', '钓鱼战利品品质倍率', 1, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['RandomSupplyCratePoints', '随机补给箱位置', false, 'switch'],
        ['AllowCrateSpawnsOnTopOfStructures', '允许补给箱降落在建筑上', false, 'switch'],
        ['ItemStackSizeMultiplier', '物品堆叠倍率', 1, 'number'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['GlobalSpoilingTimeMultiplier', '物品腐坏时间倍率', 1, 'number'],
        ['GlobalItemDecompositionTimeMultiplier', '掉落物消失时间倍率', 1, 'number'],
        ['GlobalCorpseDecompositionTimeMultiplier', '尸体分解时间倍率', 1, 'number'],
        ['UseCorpseLifeSpanMultiplier', '尸体寿命倍率', 1, 'number'],
        ['GlobalPoweredBatteryDurabilityDecreasePerSecond', '供电电池每秒耐久消耗', 3, 'number'],
        ['FuelConsumptionIntervalMultiplier', '燃料消耗间隔倍率', 1, 'number'],
        ['CropDecaySpeedMultiplier', '作物腐败速度倍率', 1, 'number'],
        ['CropGrowthSpeedMultiplier', '作物生长速度倍率', 1, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['ClampItemSpoilingTimes', '强制物品腐坏时间上限', false, 'switch'],
        ['ClampItemStats', '启用物品属性上限', false, 'switch', '配合「装备属性限制」使用。'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['LimitNonPlayerDroppedItemsCount', '非玩家掉落物数量限制', 0, 'integer'],
        ['LimitNonPlayerDroppedItemsRange', '非玩家掉落物限制半径', 0, 'integer'],
      ]),
    ],
  },
  {
    title: '印痕、掉落与刷怪规则',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['DinoSpawnWeightMultipliers', '生物刷新权重', null, 'list'],
        ['DinoClassDamageMultipliers', '指定野生生物伤害', null, 'list'],
        ['DinoClassResistanceMultipliers', '指定野生生物抗性', null, 'list'],
        ['TamedDinoClassDamageMultipliers', '指定驯养生物伤害', null, 'list'],
        ['TamedDinoClassResistanceMultipliers', '指定驯养生物抗性', null, 'list'],
        ['NPCReplacements', '生物替换', null, 'list'],
        ['ConfigAddNPCSpawnEntriesContainer', '添加生物刷新条目', null, 'list'],
        ['ConfigOverrideNPCSpawnEntriesContainer', '替换生物刷新条目', null, 'list'],
        ['ConfigSubtractNPCSpawnEntriesContainer', '移除生物刷新条目', null, 'list'],
        ['HarvestResourceItemAmountClassMultipliers', '指定资源采集量', null, 'list'],
        ['ConfigOverrideItemCraftingCosts', '修改指定物品的制作成本', null, 'list'],
        ['ConfigOverrideItemMaxQuantity', '修改指定物品的堆叠上限', null, 'list'],
        ['ConfigOverrideSupplyCrateItems', '修改补给箱物品', null, 'list'],
        ['ExcludeItemIndices', '补给箱排除的物品编号', null, 'list'],
        ['bAutoUnlockAllEngrams', '自动解锁所有印痕', false, 'switch'],
        ['bOnlyAllowSpecifiedEngrams', '仅允许指定印痕', false, 'switch'],
        ['EngramEntryAutoUnlocks', '指定印痕的自动解锁等级', null, 'list'],
        ['OverrideEngramEntries', '按编号调整印痕', null, 'list'],
        ['OverrideNamedEngramEntries', '按类名调整印痕', null, 'list'],
        ['OverridePlayerLevelEngramPoints', '逐级印痕点数', null, 'list'],
        ['LevelExperienceRampOverrides', '等级经验曲线', null, 'list'],
        ['OverrideMaxExperiencePointsDino', '驯养生物经验上限', null, 'integer'],
        ['OverrideMaxExperiencePointsPlayer', '玩家经验上限', null, 'integer'],
      ]),
    ],
  },
  {
    title: '互通与传输',
    options: [
      ...section('settings', 'ServerSettings', [
        ['CrossARKAllowForeignDinoDownloads', '允许来自外部服务器的生物下载', false, 'switch'],
        ['noTributeDownloads', '禁止从方舟数据下载', false, 'switch'],
        ['PreventDownloadSurvivors', '禁止下载角色', false, 'switch'],
        ['PreventDownloadItems', '禁止下载物品', false, 'switch'],
        ['PreventDownloadDinos', '禁止下载生物', false, 'switch'],
        ['PreventUploadSurvivors', '禁止上传角色', false, 'switch'],
        ['PreventUploadItems', '禁止上传物品', false, 'switch'],
        ['PreventUploadDinos', '禁止上传生物', false, 'switch'],
        ['MinimumDinoReuploadInterval', '生物再次上传冷却（秒）', 0, 'number'],
        ['TributeCharacterExpirationSeconds', '上传角色有效期（秒）', 0, 'integer'],
        ['TributeDinoExpirationSeconds', '上传生物有效期（秒）', 86400, 'integer'],
        ['TributeItemExpirationSeconds', '上传物品有效期（秒）', 86400, 'integer'],
        ['MaxTributeCharacters', '上传角色上限', 10, 'integer'],
        ['MaxTributeDinos', '上传生物上限', 20, 'integer'],
        ['MaxTributeItems', '上传物品上限', 50, 'integer'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['PreventTransferForClassNames', '禁止传输的类名', null, 'list'],
      ]),
    ],
  },
  {
    title: '公告、连接与日志',
    options: [
      ...section('settings', 'MessageOfTheDay', [
        ['Message', '进服公告', null, 'text'],
        ['Duration', '公告显示时间（秒）', 20, 'integer'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['AllowSharedConnections', '允许 Steam 家庭共享账户连接', false, 'switch'],
        ['UseExclusiveList', '使用进服白名单', false, 'switch'],
        ['BanListURL', '封禁名单地址', null, 'text'],
        ['AllowedCheatersURL', '管理员名单地址', null, 'text'],
        ['UpdateAllowedCheatersInterval', '管理员名单刷新间隔（秒）', 600, 'number'],
        ['SpectatorPassword', '旁观密码', null, 'password'],
        ['KickIdlePlayersPeriod', '空闲踢出时间（秒）', 3600, 'number'],
        ['EnableAFKKickPlayerCountPercent', '触发空闲踢出的玩家比例', 0, 'number'],
        ['AlwaysNotifyPlayerJoined', '始终通知玩家加入', false, 'switch'],
        ['DontAlwaysNotifyPlayerJoined', '关闭全服玩家加入通知', false, 'switch'],
        ['AlwaysNotifyPlayerLeft', '始终通知玩家离开', false, 'switch'],
        ['globalVoiceChat', '全服语音', false, 'switch'],
        ['ProximityChat', '附近聊天', false, 'switch'],
        ['AdminLogging', '在聊天中记录管理员命令', false, 'switch'],
        ['LogChatMessages', '写入聊天日志', false, 'switch'],
        ['ChatLogFileSplitIntervalSeconds', '聊天日志分割周期（秒）', 86400, 'integer'],
        ['ChatLogFlushIntervalSeconds', '聊天日志刷盘间隔（秒）', 86400, 'integer'],
        ['ChatLogMaxAgeInDays', '聊天日志保留天数', 5, 'integer'],
        ['bFilterCharacterNames', '过滤角色名敏感词', false, 'switch'],
        ['bFilterChat', '过滤聊天敏感词', false, 'switch'],
        ['bFilterTribeNames', '过滤部落名敏感词', false, 'switch'],
        ['BadWordListURL', '敏感词表地址', '"http://arkdedicated.com/badwords.txt"', 'text'],
        [
          'BadWordWhiteListURL',
          '敏感词白名单地址',
          '"http://arkdedicated.com/goodwords.txt"',
          'text',
        ],
        [
          'RCONServerGameLogBuffer',
          'RCON 日志缓冲条数',
          6000,
          'number',
          '后台为部落日志采集预设 6000，游戏原始默认是 600。',
        ],
        ['DontRestoreBackup', '关闭自动恢复备用存档', false, 'switch'],
        [
          'AutoRestartIntervalSeconds',
          '游戏内自动重启间隔（秒）',
          null,
          'number',
          '此项由游戏读取。主机助手的自动拉起在基础配置中设置。',
        ],
        ['ServerEnableMeshChecking', '启用穿模检查', false, 'switch'],
        ['EnableMeshBitingProtection', '启用穿模攻击防护', true, 'switch'],
        ['NPCNetworkStasisRangeScalePlayerCountStart', '生物网络休眠缩放起始人数', 0, 'integer'],
        ['NPCNetworkStasisRangeScalePlayerCountEnd', '生物网络休眠缩放结束人数', 0, 'integer'],
        ['NPCNetworkStasisRangeScalePercentEnd', '生物网络休眠范围最小比例', 0.55000001, 'number'],
      ]),
      ...section('settings', 'SessionSettings', [['MultiHome', '绑定 IP 地址', null, 'text']]),
      ...section('settings', 'ServerSettings', [
        ['ActiveTotalConversion', '全转换模组 ID', null, 'text'],
      ]),
      ...section('game', 'ModInstaller', [
        [
          'ModIDS',
          '额外下载的 Workshop 模组 ID',
          null,
          'list',
          '每条一个 Steam Workshop ID。留空时跟随已启用的模组。',
        ],
      ]),
      ...section('settings', 'ServerSettings', [
        ['CustomDynamicConfigUrl', '动态配置文件地址', null, 'text'],
        ['CustomLiveTuningUrl', '实时平衡配置地址', null, 'text'],
      ]),
      ...section('settings', '/MultiHome', [['MultiHome', '启用自定义绑定 IP', false, 'switch']]),
    ],
  },
  {
    title: '地图专用',
    options: [
      ...section('settings', 'Ragnarok', [
        ['AllowMultipleTamedUnicorns', '允许多只驯服的独角兽', false, 'switch'],
        ['EnableVolcano', '启用火山活动', true, 'switch'],
        ['UnicornSpawnInterval', '独角兽刷新间隔（小时）', 24, 'integer'],
        ['VolcanoIntensity', '火山喷发强度', 1, 'number'],
        ['VolcanoInterval', '火山喷发间隔', 0, 'integer'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['AllowTekSuitPowersInGenesis', '创世纪允许泰克服能力', false, 'switch'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['bGenesisUseStructuresPreventionVolumes', '创世纪启用任务区禁建', false, 'switch'],
        ['bDisableGenesisMissions', '关闭创世纪任务', false, 'switch'],
        ['bDisableHexagonStore', '关闭六角币商店', false, 'switch'],
        ['bHexStoreAllowOnlyEngramTradeOption', '六角币商店仅售印痕', false, 'switch'],
        ['BaseHexagonRewardMultiplier', '六角币奖励倍率', 1, 'number'],
        ['HexagonCostMultiplier', '六角币商品价格倍率', 1, 'number'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['MaxHexagonsPerCharacter', '角色六角币上限', 2000000000, 'integer'],
      ]),
      ...section('game', '/script/shootergame.shootergamemode', [
        ['AdjustableMutagenSpawnDelayMultiplier', '诱变剂刷新延迟倍率', 1, 'number'],
        ['bDisableDefaultMapItemSets', '关闭地图默认物品套组', false, 'switch'],
        ['bDisableWorldBuffs', '关闭地图任务增益', false, 'switch'],
        ['bEnableWorldBuffScaling', '按倍率缩放地图任务增益', false, 'switch'],
        ['WorldBuffScalingEfficacy', '地图任务增益效果倍率', 1, 'number'],
        ['PGMapName', '程序生成地图名称', null, 'text', '用于程序生成地图 PGARK。'],
        [
          'PGTerrainPropertiesString',
          '程序生成地图地形参数',
          null,
          'text',
          '将 PGARK 地形参数填在同一行。',
        ],
        ['PGLastPreset', '程序生成地图预设编号', null, 'integer'],
      ]),
    ],
  },
  {
    title: '适者生存模式',
    options: [
      ...section('settings', 'TSOTF', [
        ['EnableDeathTeamSpectator', '淘汰后允许旁观队友', false, 'switch'],
        ['MaxPlayersPerTribe', '每个参赛部落人数上限', 4, 'integer'],
        ['MinPlayersToQuickStartMatch', '触发快速开局所需人数', 32, 'integer'],
        ['MinTribesToStartMatch', '触发常规开局的部落数', 5, 'integer'],
        ['PreventBosses', '关闭首领', false, 'switch'],
        ['PreventDinoSupplyCrates', '关闭生物补给箱', false, 'switch'],
        ['PreventRetameBoss', '禁止再次驯服首领', true, 'switch'],
        ['PreventSpectator', '禁止淘汰玩家旁观', false, 'switch'],
        ['PreventTribes', '禁止组建部落', false, 'switch'],
        ['TimeToQuickStartMatch', '快速开局倒计时（秒）', 120, 'integer'],
        ['TimeToStartMatch', '常规开局倒计时（秒）', 600, 'integer'],
      ]),
      ...section('settings', 'ServerSettings', [
        ['AutoCreateTribes', '自动分配参赛部落', true, 'switch'],
      ]),
    ],
  },
  {
    title: '玩家初始属性',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['PlayerBaseStatMultipliers[0]', '生命 · 玩家初始属性', 1, 'number'],
        ['PlayerBaseStatMultipliers[1]', '耐力 · 玩家初始属性', 1, 'number'],
        ['PlayerBaseStatMultipliers[2]', '眩晕 · 玩家初始属性', 1, 'number'],
        ['PlayerBaseStatMultipliers[3]', '氧气 · 玩家初始属性', 1, 'number'],
        ['PlayerBaseStatMultipliers[4]', '食物 · 玩家初始属性', 1, 'number'],
        ['PlayerBaseStatMultipliers[5]', '水分 · 玩家初始属性', 1, 'number'],
        ['PlayerBaseStatMultipliers[6]', '温度 · 玩家初始属性', 0, 'number'],
        ['PlayerBaseStatMultipliers[7]', '负重 · 玩家初始属性', 1, 'number'],
        ['PlayerBaseStatMultipliers[8]', '近战伤害 · 玩家初始属性', 0, 'number'],
        ['PlayerBaseStatMultipliers[9]', '移动速度 · 玩家初始属性', 0, 'number'],
        ['PlayerBaseStatMultipliers[10]', '抗性 · 玩家初始属性', 0, 'number'],
        ['PlayerBaseStatMultipliers[11]', '制作技能 · 玩家初始属性', 0, 'number'],
      ]),
    ],
  },
  {
    title: '玩家每级属性',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['PerLevelStatsMultiplier_Player[0]', '生命 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[1]', '耐力 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[2]', '眩晕 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[3]', '氧气 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[4]', '食物 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[5]', '水分 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[6]', '温度 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[7]', '负重 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[8]', '近战伤害 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[9]', '移动速度 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[10]', '抗性 · 玩家每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_Player[11]', '制作技能 · 玩家每级属性', 1, 'number'],
      ]),
    ],
  },
  {
    title: '野生生物每级属性',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['PerLevelStatsMultiplier_DinoWild[0]', '生命 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[1]', '耐力 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[2]', '眩晕 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[3]', '氧气 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[4]', '食物 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[5]', '水分 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[6]', '温度 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[7]', '负重 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[8]', '近战伤害 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[9]', '移动速度 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[10]', '抗性 · 野生生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoWild[11]', '制作技能 · 野生生物每级属性', 1, 'number'],
      ]),
    ],
  },
  {
    title: '驯养生物每级属性',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['PerLevelStatsMultiplier_DinoTamed[0]', '生命 · 驯养生物每级属性', 0.2, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[1]', '耐力 · 驯养生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[2]', '眩晕 · 驯养生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[3]', '氧气 · 驯养生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[4]', '食物 · 驯养生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[5]', '水分 · 驯养生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[6]', '温度 · 驯养生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[7]', '负重 · 驯养生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[8]', '近战伤害 · 驯养生物每级属性', 0.17, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[9]', '移动速度 · 驯养生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[10]', '抗性 · 驯养生物每级属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed[11]', '制作技能 · 驯养生物每级属性', 1, 'number'],
      ]),
    ],
  },
  {
    title: '驯养生物附加属性',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['PerLevelStatsMultiplier_DinoTamed_Add[0]', '生命 · 驯养生物附加属性', 0.14, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[1]', '耐力 · 驯养生物附加属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[2]', '眩晕 · 驯养生物附加属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[3]', '氧气 · 驯养生物附加属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[4]', '食物 · 驯养生物附加属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[5]', '水分 · 驯养生物附加属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[6]', '温度 · 驯养生物附加属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[7]', '负重 · 驯养生物附加属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[8]', '近战伤害 · 驯养生物附加属性', 0.14, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[9]', '移动速度 · 驯养生物附加属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[10]', '抗性 · 驯养生物附加属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Add[11]', '制作技能 · 驯养生物附加属性', 1, 'number'],
      ]),
    ],
  },
  {
    title: '驯养效率属性',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[0]', '生命 · 驯养效率属性', 0.44, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[1]', '耐力 · 驯养效率属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[2]', '眩晕 · 驯养效率属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[3]', '氧气 · 驯养效率属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[4]', '食物 · 驯养效率属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[5]', '水分 · 驯养效率属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[6]', '温度 · 驯养效率属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[7]', '负重 · 驯养效率属性', 1, 'number'],
        [
          'PerLevelStatsMultiplier_DinoTamed_Affinity[8]',
          '近战伤害 · 驯养效率属性',
          0.44,
          'number',
        ],
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[9]', '移动速度 · 驯养效率属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[10]', '抗性 · 驯养效率属性', 1, 'number'],
        ['PerLevelStatsMultiplier_DinoTamed_Affinity[11]', '制作技能 · 驯养效率属性', 1, 'number'],
      ]),
    ],
  },
  {
    title: '野生血统诱变等级',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['MutagenLevelBoost[0]', '生命 · 野生血统诱变等级', 5, 'integer'],
        ['MutagenLevelBoost[1]', '耐力 · 野生血统诱变等级', 5, 'integer'],
        ['MutagenLevelBoost[2]', '眩晕 · 野生血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost[3]', '氧气 · 野生血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost[4]', '食物 · 野生血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost[5]', '水分 · 野生血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost[6]', '温度 · 野生血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost[7]', '负重 · 野生血统诱变等级', 5, 'integer'],
        ['MutagenLevelBoost[8]', '近战伤害 · 野生血统诱变等级', 5, 'integer'],
        ['MutagenLevelBoost[9]', '移动速度 · 野生血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost[10]', '抗性 · 野生血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost[11]', '制作技能 · 野生血统诱变等级', 0, 'integer'],
      ]),
    ],
  },
  {
    title: '繁殖血统诱变等级',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['MutagenLevelBoost_Bred[0]', '生命 · 繁殖血统诱变等级', 1, 'integer'],
        ['MutagenLevelBoost_Bred[1]', '耐力 · 繁殖血统诱变等级', 1, 'integer'],
        ['MutagenLevelBoost_Bred[2]', '眩晕 · 繁殖血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost_Bred[3]', '氧气 · 繁殖血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost_Bred[4]', '食物 · 繁殖血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost_Bred[5]', '水分 · 繁殖血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost_Bred[6]', '温度 · 繁殖血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost_Bred[7]', '负重 · 繁殖血统诱变等级', 1, 'integer'],
        ['MutagenLevelBoost_Bred[8]', '近战伤害 · 繁殖血统诱变等级', 1, 'integer'],
        ['MutagenLevelBoost_Bred[9]', '移动速度 · 繁殖血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost_Bred[10]', '抗性 · 繁殖血统诱变等级', 0, 'integer'],
        ['MutagenLevelBoost_Bred[11]', '制作技能 · 繁殖血统诱变等级', 0, 'integer'],
      ]),
    ],
  },
  {
    title: '装备属性限制',
    options: [
      ...section('game', '/script/shootergame.shootergamemode', [
        ['ItemStatClamps[0]', '品质 · 装备属性限制', null, 'integer'],
        ['ItemStatClamps[1]', '护甲 · 装备属性限制', null, 'integer'],
        ['ItemStatClamps[2]', '耐久 · 装备属性限制', null, 'integer'],
        ['ItemStatClamps[3]', '武器伤害 · 装备属性限制', null, 'integer'],
        ['ItemStatClamps[4]', '弹匣 · 装备属性限制', null, 'integer'],
        ['ItemStatClamps[5]', '耐寒 · 装备属性限制', null, 'integer'],
        ['ItemStatClamps[6]', '重量 · 装备属性限制', null, 'integer'],
        ['ItemStatClamps[7]', '耐热 · 装备属性限制', null, 'integer'],
      ]),
    ],
  },
];

export const advancedOptions = advancedGroups.flatMap((group) => group.options);
export const advancedById = new Map(advancedOptions.map((option) => [optionId(option), option]));
