import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import { INI_FILES } from '@ark-control/common';
import type { ConfigAuditEntry } from '@ark-control/common';
import { useTranslation } from 'react-i18next';
import { request } from '@/api';
import { configChangeLabel, configChangeValue } from '@/game-config';

export default function ConfigAuditDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [entry, setEntry] = useState<ConfigAuditEntry>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let open = true;
    void request<ConfigAuditEntry>('/audit/' + encodeURIComponent(id)).then(
      (record) => {
        if (open) setEntry(record);
      },
      (failure: unknown) => {
        if (open) setError(failure instanceof Error ? failure.message : '配置修改记录加载失败。');
      },
    );
    return () => {
      open = false;
    };
  }, [id]);

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby="config-audit-title">
      <DialogTitle id="config-audit-title">{t('配置修改记录')}</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error">{t(error)}</Alert>}
        {!error && !entry && <CircularProgress size={24} aria-label={t('加载中')} />}
        {entry && (
          <Stack spacing={2.5}>
            <Stack spacing={0.5} sx={{ overflowWrap: 'anywhere' }}>
              <Typography variant="subtitle1">{entry.target}</Typography>
              <Typography variant="body2" color="text.secondary">
                {t('操作用户')} · {entry.actor}
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                component="time"
                dateTime={entry.createdAt}
              >
                {t('时间')} ·{' '}
                {new Date(entry.createdAt).toLocaleString(i18n.language, {
                  timeZone: 'Asia/Shanghai',
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false,
                })}
              </Typography>
            </Stack>
            <Stack
              component="ol"
              aria-label={t('修改项')}
              spacing={1.25}
              sx={{ m: 0, p: 0, listStyle: 'none' }}
            >
              {entry.changes.map((change, index) => (
                <Box
                  component="li"
                  key={index}
                  sx={{
                    p: 1.5,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 2,
                    overflowWrap: 'anywhere',
                  }}
                >
                  <Typography variant="subtitle2">{configChangeLabel(change, t)}</Typography>
                  {'file' in change && change.key && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {INI_FILES[change.file]} · [{change.section}] {change.key}
                    </Typography>
                  )}
                  {change.key && (
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: {
                          xs: 'minmax(0, 1fr)',
                          sm: 'repeat(2, minmax(0, 1fr))',
                        },
                        gap: 1.25,
                        mt: 0.75,
                      }}
                    >
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          {t('修改前')}
                        </Typography>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                          {configChangeValue(change.before, !!change.redacted, t)}
                        </Typography>
                      </Box>
                      <Box>
                        <Typography variant="caption" color="text.secondary">
                          {t('修改后')}
                        </Typography>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                          {configChangeValue(change.after, !!change.redacted, t)}
                        </Typography>
                      </Box>
                    </Box>
                  )}
                </Box>
              ))}
            </Stack>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('关闭')}</Button>
      </DialogActions>
    </Dialog>
  );
}
