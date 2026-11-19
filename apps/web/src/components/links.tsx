import { readableTextColor, type CrestConfig } from '@fd/shared';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Crest } from './Crest';

export interface ClubRefFull { id: string; name: string; short_name: string; control?: 'human' | 'ai'; color?: string | null; color2?: string | null; crest?: CrestConfig | null }

/** Anklickbarer Vereinsname → Vereinsprofil */
export function ClubLink({ club, children, className = '' }: { club: { id: string; name: string } | null | undefined; children?: ReactNode; className?: string }) {
  const { worldId = '' } = useParams();
  if (!club) return <>{children}</>;
  return <Link to={`/w/${worldId}/club/${club.id}`} className={`hover:text-gold hover:underline ${className}`} onClick={(e) => e.stopPropagation()}>{children ?? club.name}</Link>;
}

/** Anklickbarer Spielername → Spielerprofil */
export function PlayerLink({ id, children, className = '' }: { id: string | null | undefined; children: ReactNode; className?: string }) {
  const { worldId = '' } = useParams();
  if (!id) return <>{children}</>;
  return <Link to={`/w/${worldId}/spieler/${id}`} className={`hover:text-gold hover:underline ${className}`} onClick={(e) => e.stopPropagation()}>{children}</Link>;
}

/** Vereinslogo (Wappen, sonst Kürzel in Vereinsfarbe) */
export function ClubLogo({ club, size = 28 }: { club: ClubRefFull; size?: number }) {
  if (club.crest) return <Crest crest={club.crest} size={size} className="shrink-0" />;
  const color = club.color ?? '#3a4a3a';
  return (
    <span className="display grid shrink-0 place-items-center rounded-md px-1 text-[11px] font-bold" style={{ height: size, minWidth: size * 1.3, background: color, color: readableTextColor(color) }}>
      {club.short_name}
    </span>
  );
}
