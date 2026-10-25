import { ApiError, body, database, fail, guard, json, owner, query } from '@/lib/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

/** Every chunk and commit is bound to the verified caller, never an uploaded owner. */
export async function POST(request: Request) {
  try {
    guard(request);
    const user = await owner();
    const data = await body(request, 750000);
    const actions = ['begin_export', 'read_export', 'begin_import', 'upload', 'preview', 'apply', 'cancel'];
    if (typeof data.action !== 'string' || !actions.includes(data.action)) throw new ApiError('Choose a valid transfer operation.');
    if (!data.action.startsWith('begin_') && (typeof data.job !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.job))) {
      throw new ApiError('Choose a valid workspace transfer.');
    }
    if (data.action === 'upload' && (typeof data.chunk !== 'string' || data.chunk.length > 720000 || !/^[A-Za-z0-9+/=\s]+$/.test(data.chunk))) {
      throw new ApiError('This upload chunk is invalid.');
    }
    if (['upload', 'read_export'].includes(data.action) && (!Number.isInteger(data.index) || data.index < 0 || data.index >= 200)) {
      throw new ApiError('This transfer chunk is invalid.');
    }
    if (data.action === 'begin_import' && (!Number.isInteger(data.bytes) || data.bytes < 1 || data.bytes > 104857600)) {
      throw new ApiError('Choose a backup smaller than 100 MB.');
    }
    const result = await query(database().rpc('desk_workspace_transfer', {
      p_owner: user,
      p_action: data.action,
      p_job: data.job || null,
      p_data: { index: data.index, chunk: data.chunk, bytes: data.bytes, overwrite: data.overwrite === true, restoreSettings: data.restoreSettings === true },
    }));
    return json(result);
  } catch (error) { return fail(error); }
}
