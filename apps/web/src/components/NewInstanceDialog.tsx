import {
  MAPS,
  GAME_BRANCHES,
  estimateCapacity,
  gameConfigSchema,
  shareableServerFiles,
} from '@ark-control/common';
import { useWorkspaceStore } from '@/store';
import { useWorkspaceCan } from '@/store/workspace-selection';
import { request } from '@/api';
import { FormDialog, useMutation } from '@/components';
import type { Field, FormValues } from '@/components';

export default function NewInstanceDialog({
  onClose,
  initialHostId,
  initialFileSource,
}: {
  onClose: () => void;
  initialHostId?: string;
  initialFileSource?: string;
}) {
  const data = useWorkspaceStore((state) => state.data);
  const can = useWorkspaceCan();
  const hosts =
    data?.hosts.filter((item) => can('maps.create', { kind: 'host', hostId: item.id })) ?? [];
  const mutate = useMutation();
  const count = data?.instances.length ?? 0;
  const fields = (values: FormValues): Field[] => {
    const host = data?.hosts.find((item) => item.id === values.hostId);
    const sources = (data?.serverFiles ?? []).filter(
      (file) =>
        file.hostId === values.hostId &&
        shareableServerFiles(file) &&
        file.branch === values.branch &&
        !(data?.fileTasks ?? []).some(
          (task) =>
            ['queued', 'leased', 'executing', 'cancelling'].includes(task.status) &&
            (task.assetId === file.id || task.payload.sourceId === file.id),
        ),
    );
    const estimate = host
      ? estimateCapacity(host, data?.instances ?? [], Number(values.maxPlayers || 20), 0)
      : null;
    const helper = !estimate
      ? '先选择主机。'
      : `启动资源${{ sufficient: '预计充足', tight: '接近上限', insufficient: '不足', unknown: '等待主机采样' }[estimate.verdict]}。地图内存预算约 ${(estimate.estimatedMemoryMb / 1024).toFixed(1)} GB。${estimate.blockingReasons.join(' ')}`;
    return [
      { key: 'name', label: '名称', required: true },
      {
        key: 'branch',
        label: 'Steam 版本分支',
        kind: 'select',
        required: true,
        options: [...GAME_BRANCHES],
        helper: '跟随所选分支更新。玩家需在 Steam 选择相同分支；不同分支不会混用下载文件。',
      },
      {
        key: 'hostId',
        label: '主机',
        kind: 'select',
        required: true,
        options: hosts.map((item) => ({
          value: item.id,
          label: `${item.name} · ${item.status === 'online' ? '在线' : '待连接'}`,
        })),
        helper,
      },
      {
        key: 'map',
        label: '地图',
        kind: 'select',
        required: true,
        options: MAPS.map((item) => ({ value: item.value, label: item.label })),
      },
      {
        key: 'serverFileSource',
        label: '服务端文件来源',
        kind: 'select',
        required: true,
        options: [
          { value: 'auto', label: '自动共用本机同分支文件，没有时下载' },
          ...sources.map((file) => ({
            value: file.id,
            label: `${file.name} · ${file.buildId ?? '未标注版本'}`,
          })),
          ...(!['auto', 'download'].includes(String(values.serverFileSource)) &&
          !sources.some((file) => file.id === values.serverFileSource)
            ? [{ value: String(values.serverFileSource), label: '所选文件当前不可用，请重新选择' }]
            : []),
        ],
        helper: '同一套服务端文件可同时运行多张地图。每张地图使用独立的配置、存档、日志和端口。',
      },
      { key: 'maxPlayers', label: '玩家上限', kind: 'number', min: 1, max: 200, required: true },
      { key: 'gamePort', label: '游戏端口', kind: 'number', min: 1024, max: 65534, required: true },
      {
        key: 'queryPort',
        label: '查询端口',
        kind: 'number',
        min: 1024,
        max: 65534,
        required: true,
      },
      {
        key: 'rconPort',
        label: 'RCON 端口',
        kind: 'number',
        min: 1024,
        max: 65534,
        required: true,
      },
      {
        key: 'clusterId',
        label: '互通组',
        helper: '可留空；同组地图使用相同标识。跨主机互通需要共享目录。',
      },
      { key: 'pve', label: 'PVE 模式', kind: 'switch' },
      { key: 'autoRestart', label: '自动拉起', kind: 'switch' },
      { key: 'autoBranchUpdate', label: '自动跟随分支更新（备份后维护重启）', kind: 'switch' },
    ];
  };
  const handleSubmit = (values: FormValues) =>
    mutate(() =>
      request('/instances', 'POST', {
        name: values.name,
        hostId: values.hostId,
        map: values.map,
        gamePort: Number(values.gamePort),
        queryPort: Number(values.queryPort),
        rconPort: Number(values.rconPort),
        clusterId: values.clusterId,
        autoRestart: values.autoRestart,
        branch: values.branch,
        autoBranchUpdate: values.autoBranchUpdate,
        serverFileSource: values.serverFileSource,
        config: gameConfigSchema.parse({
          sessionName: values.name,
          maxPlayers: Number(values.maxPlayers),
          pve: values.pve,
        }),
      }),
    );
  return (
    <FormDialog
      title="新建地图"
      description="创建后点击准备服务端。已有同分支文件时直接关联，无需复制。启动前会检查主机资源和端口。"
      fields={fields}
      initial={{
        name: '',
        branch:
          data?.serverFiles?.find((file) => file.id === initialFileSource)?.branch === 'preaquatica'
            ? 'preaquatica'
            : 'public',
        autoBranchUpdate: true,
        hostId: hosts.find((item) => item.id === initialHostId)?.id ?? hosts[0]?.id ?? '',
        serverFileSource: initialFileSource ?? 'auto',
        map: 'TheIsland',
        maxPlayers: '20',
        gamePort: String(7777 + count * 2),
        queryPort: String(27015 + count),
        rconPort: String(27020 + count),
        clusterId: '',
        pve: true,
        autoRestart: true,
      }}
      onClose={onClose}
      onSubmit={handleSubmit}
      submitLabel="创建地图"
    />
  );
}
