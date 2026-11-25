import { useEffect, useState } from 'react';
import type { ClusterPresetGroup } from '@ark-control/common';
import { request } from '@/api';
import { useWorkspaceSelection } from '@/store/workspace-selection';

export function useClusterPresets() {
  const workspaceId = useWorkspaceSelection((state) => state.active?.id);
  const [result, setResult] = useState<{
    workspaceId: string;
    groups: ClusterPresetGroup[];
    error?: string;
  }>();
  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void request<ClusterPresetGroup[]>('/clusters/presets')
      .then((groups) => {
        if (active) setResult({ workspaceId, groups });
      })
      .catch((failure: unknown) => {
        if (active)
          setResult({
            workspaceId,
            groups: [],
            error: failure instanceof Error ? failure.message : '读取互通组配置失败。',
          });
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);
  const loaded = result && result.workspaceId === workspaceId ? result : undefined;
  return { groups: loaded?.groups ?? [], error: loaded?.error, loading: !loaded };
}
