import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Alert, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import { workspaceStatuses } from '@ark-control/common';
import type { Workspace } from '@ark-control/common';
import { request } from '@/api';
import { Empty, PageHeading, Surface } from '@/components';
import { useAuthStore, useUiStore } from '@/store';
import { useWorkspaceSelection } from '@/store/workspace-selection';

export default function Workspaces() {
  const navigate = useNavigate();
  const accountId = useAuthStore((state) => state.admin?.id ?? '');
  const notify = useUiStore((state) => state.notify);
  const { spaces, active, load, select } = useWorkspaceSelection();
  const own = spaces.find((item) => item.role === 'owner');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent, action: 'apply' | 'accept') {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (action === 'apply') {
        await request<Workspace>('/workspaces', 'POST', { name: name.trim() });
        await load(accountId);
        setName('');
        notify('工作空间申请已提交。');
      } else {
        const { workspaceId } = await request<{ workspaceId: string }>(
          '/workspaces/accept',
          'POST',
          { code: code.trim() },
        );
        await load(accountId);
        select(workspaceId);
        navigate('/');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '提交失败。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeading
        title="我的工作空间"
        description="管理自己的方舟服务器，或进入其他服主邀请你协管的空间。"
      />
      <Stack spacing={2.5}>
        {error && <Alert severity="error">{error}</Alert>}
        {spaces.length ? (
          spaces.map((space) => (
            <Surface key={space.id} sx={{ p: 2.5 }}>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                gap={1.5}
                alignItems={{ sm: 'center' }}
              >
                <Typography variant="h4" sx={{ flex: 1, overflowWrap: 'anywhere' }}>
                  {space.name}
                </Typography>
                <Stack direction="row" gap={1} flexWrap="wrap">
                  <Chip size="small" label={space.role === 'owner' ? '服主' : '协管'} />
                  <Chip
                    size="small"
                    color={space.status === 'active' ? 'success' : 'default'}
                    label={workspaceStatuses[space.status]}
                  />
                </Stack>
                {space.status === 'active' && (
                  <Button
                    variant={active?.id === space.id ? 'text' : 'outlined'}
                    onClick={() => {
                      select(space.id);
                      navigate('/');
                    }}
                  >
                    进入工作空间
                  </Button>
                )}
              </Stack>
            </Surface>
          ))
        ) : (
          <Empty title="你还没有工作空间" />
        )}
        {(!own || own.status === 'rejected') && (
          <Surface sx={{ p: 2.5 }}>
            <Stack
              component="form"
              spacing={2}
              onSubmit={(event: FormEvent) => void submit(event, 'apply')}
            >
              <Typography variant="h4">申请服主工作空间</Typography>
              <TextField
                required
                label="工作空间名称"
                value={name}
                onChange={(event) => setName(event.target.value)}
                slotProps={{ htmlInput: { maxLength: 80 } }}
                sx={{ maxWidth: 500 }}
              />
              <Button
                type="submit"
                disabled={saving || !name.trim()}
                variant="contained"
                sx={{ alignSelf: 'start' }}
              >
                提交审核
              </Button>
            </Stack>
          </Surface>
        )}
        <Surface sx={{ p: 2.5 }}>
          <Stack
            component="form"
            spacing={2}
            onSubmit={(event: FormEvent) => void submit(event, 'accept')}
          >
            <Typography variant="h4">接受协管邀请</Typography>
            <TextField
              required
              label="邀请代码"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              helperText="请用服主发送邀请时填写的邮箱登录。"
              sx={{ maxWidth: 540 }}
            />
            <Button
              type="submit"
              disabled={saving || !code.trim()}
              variant="outlined"
              sx={{ alignSelf: 'start' }}
            >
              接受邀请
            </Button>
          </Stack>
        </Surface>
      </Stack>
    </>
  );
}
