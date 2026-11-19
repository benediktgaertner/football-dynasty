// Erzeugt die statischen Gewichtstabellen der Spielerentwicklung (Migration 0023) aus @fd/shared,
// damit Gesamtstärke und Trainingsverteilung in SQL exakt wie in TypeScript rechnen.
import { POSITIONS, devPositionWeights, trainingShares, DECLINE_WEIGHT, TRAINING_FOCI } from '../packages/shared/dist/index.js';
const q = (s) => `'${s}'`;
const lines = [];
lines.push(`create or replace function public.fd_dev_weights(p_kind text, p_pos text, out keys text[], out ws float8[])
language sql immutable set search_path = '' as $$
  select k, w from (values`);
const rows = [];
for (const pos of POSITIONS) {
  const kind = pos === 'GK' ? 'goalkeeper' : 'outfield';
  const w = devPositionWeights(kind, pos);
  rows.push(`    (${q(pos)}, array[${Object.keys(w).map(q).join(', ')}]::text[], array[${Object.values(w).join(', ')}]::float8[])`);
}
lines.push(rows.join(',\n') + `
  ) t(pos, k, w) where t.pos = case when p_kind = 'goalkeeper' then 'GK' else p_pos end;
$$;`);
lines.push(`create or replace function public.fd_dev_training_shares(p_kind text, p_pos text, p_focus text)
returns jsonb language sql immutable set search_path = '' as $$
  select s from (values`);
const srows = [];
for (const pos of POSITIONS) {
  const kind = pos === 'GK' ? 'goalkeeper' : 'outfield';
  for (const f of TRAINING_FOCI.map((x) => x.value)) {
    srows.push(`    (${q(pos)}, ${q(f)}, ${q(JSON.stringify(trainingShares(kind, pos, f)))}::jsonb)`);
  }
}
lines.push(srows.join(',\n') + `
  ) t(pos, focus, s) where t.pos = case when p_kind = 'goalkeeper' then 'GK' else p_pos end and t.focus = p_focus;
$$;`);
lines.push(`create or replace function public.fd_dev_decline_weight(p_key text)
returns numeric language sql immutable set search_path = '' as $$
  select coalesce((${q(JSON.stringify(DECLINE_WEIGHT))}::jsonb ->> p_key)::numeric, 0.5);
$$;`);
process.stdout.write(lines.join('\n\n') + '\n');
