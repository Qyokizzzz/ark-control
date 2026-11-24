import { useCallback } from 'react';
import { useUiStore, useWorkspaceStore } from '@/store';

export const formatDate = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Shanghai',
      }).format(new Date(value))
    : '—';
export const formatSize = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
export const matches = (query: string, ...values: unknown[]) =>
  !query || values.join(' ').toLowerCase().includes(query.toLowerCase());
export async function copyText(text: string, dialog?: Element | null) {
  const focused = document.activeElement;
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      /* Fall back for trusted LAN HTTP pages. */
    }
  }
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  const container = dialog ?? focused?.closest('[role="dialog"]');
  (container?.isConnected ? container : document.body).append(field);
  field.focus({ preventScroll: true });
  field.select();
  try {
    if (!document.execCommand('copy')) throw new Error('浏览器未允许复制，请手动复制。');
  } finally {
    field.remove();
    if (focused instanceof HTMLElement && focused.isConnected)
      focused.focus({ preventScroll: true });
  }
}
export type FormValues = Record<string, string | boolean>;
export interface Field {
  key: string;
  label: string;
  kind?: 'text' | 'number' | 'select' | 'switch' | 'password' | 'textarea';
  options?: { value: string; label: string }[];
  required?: boolean;
  helper?: string;
  min?: number;
  max?: number;
  maxLength?: number;
  placeholder?: string;
  step?: string;
  disabled?: boolean;
}
export function useMutation() {
  const notify = useUiStore((state) => state.notify);
  const load = useWorkspaceStore((state) => state.load);
  return useCallback(
    async <T>(
      operation: () => Promise<T>,
      message: string | ((result: T) => string) = '已保存',
    ): Promise<T> => {
      const result = await operation();
      await load();
      notify(typeof message === 'function' ? message(result) : message);
      return result;
    },
    [load, notify],
  );
}
