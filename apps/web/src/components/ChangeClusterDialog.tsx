import { gameBranch } from '@ark-control/common';
import type { Instance } from '@ark-control/common';
import { request } from '@/api';
import ClusterField from './ClusterField';
import FormDialog from './FormDialog';
import { useMutation } from './common';
import { useClusterPresets } from './use-cluster-presets';

export default function ChangeClusterDialog({
  instance,
  onClose,
}: {
  instance: Instance;
  onClose: () => void;
}) {
  const mutate = useMutation();
  const presets = useClusterPresets();
  return (
    <FormDialog
      title="变更互通组"
      description="换组沿用这张地图当前的游戏配置和模组。可在编辑页手动加载新组的配置。"
      fields={[{ key: 'clusterId', label: '互通组' }]}
      initial={{ clusterId: instance.clusterId }}
      onClose={onClose}
      onSubmit={({ clusterId }) =>
        clusterId === instance.clusterId
          ? Promise.resolve()
          : mutate(
              () => request(`/instances/${instance.id}`, 'PATCH', { clusterId }),
              '互通组已更新',
            )
      }
      renderField={(_field, values, change, busy) => (
        <ClusterField
          {...presets}
          value={String(values.clusterId)}
          branch={gameBranch(instance.branch)}
          disabled={busy}
          onChange={(clusterId) => change({ clusterId })}
        />
      )}
    />
  );
}
