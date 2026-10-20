import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { REPORTS_DIR, isInvestigationId } from '@/lib/reports';

export const dynamic = 'force-dynamic';

/** Downloads report.json, or record.json while the report isn't ready. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isInvestigationId(id)) return NextResponse.json({ error: 'not found' }, { status: 404 });
  for (const file of ['report.json', 'record.json']) {
    const body = await readFile(join(REPORTS_DIR, id, file), 'utf8').catch(() => null);
    if (body) {
      return new NextResponse(body, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${id}-${file}"`,
        },
      });
    }
  }
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}
