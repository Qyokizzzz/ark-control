import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const {
  GITHUB_API_URL,
  GITHUB_EVENT_NAME,
  GITHUB_OUTPUT,
  GITHUB_REPOSITORY,
  GITHUB_SHA,
  GITHUB_TOKEN,
} = process.env;

const fullBuild = { web: true, api: true, agent: true };
const sharedInputs = new Set([
  '.github/workflows/deploy-pages.yml',
  '.npmrc',
  'deploy/plan-deployment.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
]);

function affectedComponents(files) {
  if (files.some((file) => file.startsWith('common/') || sharedInputs.has(file))) return fullBuild;
  const backendBuildChanged = files.includes('scripts/build-backend.mjs');
  return {
    web: files.some((file) => file.startsWith('apps/web/') || file === 'deploy/server-address.mjs'),
    api:
      backendBuildChanged ||
      files.some(
        (file) =>
          file.startsWith('apps/api/') ||
          file === 'deploy/publish-backend.sh' ||
          file === 'deploy/rollout-backend.mjs',
      ),
    agent:
      backendBuildChanged ||
      files.some(
        (file) =>
          file.startsWith('apps/agent/') ||
          file.startsWith('deploy/agent-windows/') ||
          file === 'scripts/build-agent-package.mjs',
      ),
  };
}

async function github(path, query) {
  const url = new URL(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/${path}`);
  url.search = new URLSearchParams(query).toString();
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${GITHUB_TOKEN}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  return response.json();
}

async function lastSuccessfulDeployment(environment) {
  const deployments = await github('deployments', { environment, per_page: '20' });
  for (const { id, sha } of deployments) {
    if (!Number.isSafeInteger(id) || !/^[a-f0-9]{40}$/.test(sha)) continue;
    const [latest] = await github(`deployments/${id}/statuses`, { per_page: '1' });
    if (latest?.state === 'success') return sha;
  }
  return null;
}

async function changesSinceDeployment(environment) {
  try {
    const previous = await lastSuccessfulDeployment(environment);
    if (previous) {
      const paths = execFileSync(
        'git',
        ['diff', '--name-only', '--no-renames', '-z', previous, GITHUB_SHA, '--'],
        { encoding: 'utf8' },
      );
      console.log(`${environment} 上次成功部署 ${previous}`);
      return affectedComponents(paths.split('\0'));
    }
  } catch (error) {
    console.warn(`${environment} 无法比较部署历史，使用完整构建。 ${error.message}`);
    return fullBuild;
  }
  console.log(`${environment} 尚无成功部署记录，使用完整构建。`);
  return fullBuild;
}

const [pages, backend] =
  GITHUB_EVENT_NAME === 'workflow_dispatch'
    ? [fullBuild, fullBuild]
    : await Promise.all([
        changesSinceDeployment('github-pages'),
        changesSinceDeployment('backend'),
      ]);

const plan = { web: pages.web, api: backend.api, agent: backend.agent };
const result = Object.entries(plan).map(([component, changed]) => `${component}=${changed}\n`);
appendFileSync(GITHUB_OUTPUT, result.join(''));
console.log(result.join('').trim());
