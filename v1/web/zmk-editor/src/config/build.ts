/**
 * Client for the firmware-build endpoints served by the Cloudflare
 * Worker (web/worker/index.ts). The Worker holds a GitHub token and:
 *
 *   POST /zmk/__build            → dispatch the parameterised build,
 *                                  returns a build_id
 *   GET  /zmk/__build/status     → poll run status by build_id
 *   GET  /zmk/__artifact         → proxy the built artifact zip
 *
 * The browser never sees the token. The artifact is a zip of the UF2s;
 * we unzip it client-side with fflate.
 */

import { unzipSync } from 'fflate';

export interface DispatchResult {
  ok: boolean;
  buildId?: string;
  error?: string;
}

export interface StatusResult {
  status: 'queued' | 'in_progress' | 'completed' | 'unknown';
  conclusion: string | null;
  runId?: number;
}

export async function postBuild(overrides: Record<string, number>): Promise<DispatchResult> {
  let res: Response;
  try {
    res = await fetch('/zmk/__build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ overrides }),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 501) {
    return {
      ok: false,
      error: 'ビルド連携が未設定です（サーバーに GitHub トークンが設定されていません）。',
    };
  }
  if (!res.ok) return { ok: false, error: `ビルドの開始に失敗しました: HTTP ${res.status}` };
  const j = (await res.json()) as { build_id?: string };
  if (!j.build_id) return { ok: false, error: 'build_id が返りませんでした。' };
  return { ok: true, buildId: j.build_id };
}

export async function getBuildStatus(buildId: string): Promise<StatusResult> {
  const res = await fetch(`/zmk/__build/status?build_id=${encodeURIComponent(buildId)}`);
  if (!res.ok) return { status: 'unknown', conclusion: null };
  const j = (await res.json()) as { status?: string; conclusion?: string | null; run_id?: number };
  return {
    status: (j.status as StatusResult['status']) ?? 'unknown',
    conclusion: j.conclusion ?? null,
    ...(j.run_id !== undefined ? { runId: j.run_id } : {}),
  };
}

/** Fetch + unzip the build artifact, returning UF2s keyed by filename. */
export async function fetchArtifactUf2s(runId: number): Promise<Record<string, Uint8Array>> {
  const res = await fetch(`/zmk/__artifact?run_id=${runId}`);
  if (!res.ok) throw new Error(`アーティファクトの取得に失敗しました: HTTP ${res.status}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  const files = unzipSync(zip);
  const out: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith('.uf2')) continue;
    const base = name.split('/').pop();
    if (base) out[base] = bytes;
  }
  return out;
}
