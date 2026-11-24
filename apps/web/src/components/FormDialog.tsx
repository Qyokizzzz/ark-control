import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
} from '@mui/material';
import { ArrowRightIcon } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import FormField from './FormField';
import type { Field, FormValues } from './common';

type Fields = Field[] | ((values: FormValues) => Field[]);

export default function FormDialog({
  title,
  fields,
  initial,
  onClose,
  onSubmit,
  submitLabel = '保存',
  description,
}: {
  title: string;
  fields: Fields;
  initial: FormValues;
  onClose: () => void;
  onSubmit: (values: FormValues) => Promise<unknown>;
  submitLabel?: string;
  description?: string;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        await onSubmit(values);
        onClose();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : '操作失败。');
      } finally {
        setBusy(false);
      }
    },
    [onClose, onSubmit, values],
  );
  return (
    <Dialog open onClose={busy ? undefined : onClose}>
      <Box component="form" onSubmit={handleSubmit}>
        <DialogTitle>{t(title)}</DialogTitle>
        <DialogContent>
          <Stack spacing={3} sx={{ pt: 1 }}>
            {description && <Alert severity="info">{t(description)}</Alert>}
            {error && <Alert severity="error">{t(error)}</Alert>}
            {(typeof fields === 'function' ? fields(values) : fields).map((field) => (
              <FormField
                key={field.key}
                field={field}
                value={values[field.key]}
                disabled={busy}
                onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
              />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={busy}>
            {t('取消')}
          </Button>
          <Button
            type="submit"
            variant="contained"
            disabled={busy}
            endIcon={<ArrowRightIcon size={16} />}
          >
            {busy ? t('正在处理…') : t(submitLabel)}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
