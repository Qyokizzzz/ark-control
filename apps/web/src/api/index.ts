import axios from 'axios';
import type { AxiosError, InternalAxiosRequestConfig } from 'axios';
import type { Admin, ApiEnvelope } from '@ark-control/common';
import { useAuthStore } from '@/store/auth';
import { useWorkspaceSelection } from '@/store/workspace-selection';
import { apiBase } from '@/deployment';

export const http = axios.create({ baseURL: apiBase, withCredentials: true, timeout: 25000 });
const refreshHttp = axios.create({ baseURL: apiBase, withCredentials: true, timeout: 15000 });
let refreshing: Promise<void> | null = null;
export async function restoreSession() {
  if (!refreshing)
    refreshing = (async () => {
      try {
        const response =
          await refreshHttp.post<ApiEnvelope<{ accessToken: string; admin: Admin }>>(
            '/auth/refresh',
          );
        const session = response.data.data;
        useAuthStore.getState().setSession(session.accessToken, session.admin);
      } catch {
        useAuthStore.getState().clear();
      } finally {
        refreshing = null;
      }
    })();
  return refreshing;
}
type ScopedRequest = InternalAxiosRequestConfig & {
  _retried?: boolean;
  _workspaceRevision?: number;
};
const globalPath = /^\/(?:auth|workspaces|platform)(?:\/|$)/;
function sameWorkspace(request?: ScopedRequest) {
  return (
    request?._workspaceRevision === undefined ||
    request._workspaceRevision === useWorkspaceSelection.getState().revision
  );
}
http.interceptors.request.use(
  (request: ScopedRequest) => {
    const token = useAuthStore.getState().accessToken;
    if (token) request.headers.Authorization = `Bearer ${token}`;
    if (!globalPath.test(request.url ?? '')) {
      const { active, revision } = useWorkspaceSelection.getState();
      request._workspaceRevision ??= revision;
      if (active && sameWorkspace(request)) request.headers.set('X-Ark-Workspace', active.id);
    }
    return request;
  },
  undefined,
  { synchronous: true },
);
http.interceptors.response.use(
  (response) => {
    if (!sameWorkspace(response.config)) return Promise.reject(new Error('工作空间已切换。'));
    const payload = response.data as Partial<ApiEnvelope<unknown>>;
    if (payload && typeof payload === 'object' && 'code' in payload && payload.code !== 'OK')
      return Promise.reject(new Error(payload.message ?? '操作失败。'));
    return response;
  },
  async (error: AxiosError<ApiEnvelope<null>>) => {
    const request = error.config as ScopedRequest | undefined;
    if (!sameWorkspace(request)) return Promise.reject(new Error('工作空间已切换。'));
    if (
      error.response?.status === 401 &&
      request &&
      !request._retried &&
      !request.url?.startsWith('/auth/')
    ) {
      request._retried = true;
      await restoreSession();
      const token = useAuthStore.getState().accessToken;
      if (token && sameWorkspace(request)) {
        request.headers.Authorization = `Bearer ${token}`;
        return http(request);
      }
    }
    const payload =
      error.response?.data instanceof Blob
        ? await error.response.data
            .text()
            .then((text) => JSON.parse(text) as ApiEnvelope<null>)
            .catch(() => undefined)
        : error.response?.data;
    console.warn('[HTTP 请求最终失败]', {
      method: request?.method,
      path: request?.url?.split(/[?#]/)[0],
      status: error.response?.status,
      axiosCode: error.code,
      apiCode: payload?.code,
    });
    return Promise.reject(
      new Error(
        payload?.message ??
          (error.code === 'ECONNABORTED'
            ? '请求超时，请检查后台连接。'
            : '连接失败，请确认管理服务已启动。'),
        { cause: payload?.code },
      ),
    );
  },
);
export async function request<T>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  data?: unknown,
): Promise<T> {
  return (await http.request<ApiEnvelope<T>>({ url: path, method, data })).data.data;
}
export async function downloadBackup(id: string) {
  const response = await http.get<Blob>(`/backups/${id}/download`, {
    responseType: 'blob',
    timeout: 3600000,
  });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ark-backup-${id}.zip`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function downloadAgent() {
  const response = await http.get<Blob>('/agent-package/windows', {
    responseType: 'blob',
    timeout: 120000,
  });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ArkHostAgent-Windows-x64.zip';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export async function downloadConnection(id: string) {
  let response;
  try {
    response = await http.get<Blob>(`/connections/invites/${id}/download`, {
      responseType: 'blob',
      timeout: 120000,
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : '联机包下载失败。');
  }
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ArkConnect-${id.slice(0, 8)}.exe`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
